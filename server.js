const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const MATCH_FILE = path.join(DATA_DIR, "matches.json");
const fsp = fs.promises;
const MODE_SET = new Set(["solo", "duel", "pvp"]);
const DIFFICULTY_SET = new Set(["easy", "medium", "hard"]);
const WINNER_SET = new Set(["you", "draw", "bot", "opponent"]);
const MAX_SCORE = 1_000_000;
const MAX_PATTERNS = 100_000;
const MAX_NAME_LEN = 32;
const MAX_MATCH_ID_LEN = 120;

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(MATCH_FILE)) {
    fs.writeFileSync(MATCH_FILE, "[]", "utf8");
  }
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) {
    return xf.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || null;
}

async function readMatches() {
  try {
    const raw = await fsp.readFile(MATCH_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeMatchesAtomic(matches) {
  const tmp = `${MATCH_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(matches, null, 2), "utf8");
  try {
    await fsp.rename(tmp, MATCH_FILE);
  } catch (err) {
    // Some Windows setups may fail to replace an existing file. Retry once.
    try {
      await fsp.unlink(MATCH_FILE);
    } catch {
      /* ignore */
    }
    await fsp.rename(tmp, MATCH_FILE);
  }
}

/*
 * Single-process write queue:
 * serializes read-modify-write cycles so concurrent requests can't clobber
 * each other, while keeping IO async (non-blocking).
 */
let writeQueue = Promise.resolve();
function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function normalizeText(value, maxLen = 64) {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLen);
  return cleaned;
}

function parseTimestamp(value, fallbackIso) {
  if (value == null || value === "") return fallbackIso || null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseIntBounded(value, { min = 0, max = Number.MAX_SAFE_INTEGER, allowNull = false } = {}) {
  if (value == null || value === "") return allowNull ? null : min;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const int = Math.trunc(num);
  if (int < min || int > max) return null;
  return int;
}

function sanitizeMatchPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, message: "Payload must be an object." };
  }

  const mode = normalizeText(payload.mode || "solo", 12).toLowerCase();
  if (!MODE_SET.has(mode)) return { ok: false, message: "Invalid mode." };

  const difficulty = normalizeText(payload.difficulty || "medium", 12).toLowerCase();
  if (!DIFFICULTY_SET.has(difficulty)) return { ok: false, message: "Invalid difficulty." };

  const duration = parseIntBounded(payload.duration, { min: 60, max: 120 });
  if (duration == null) return { ok: false, message: "Invalid duration." };

  const playerScore = parseIntBounded(payload.playerScore, { min: 0, max: MAX_SCORE });
  if (playerScore == null) return { ok: false, message: "Invalid playerScore." };

  const botScore = payload.botScore == null ? null : parseIntBounded(payload.botScore, { min: 0, max: MAX_SCORE });
  if (payload.botScore != null && botScore == null) return { ok: false, message: "Invalid botScore." };

  const patternsPlayed = parseIntBounded(payload.patternsPlayed, { min: 0, max: MAX_PATTERNS });
  if (patternsPlayed == null) return { ok: false, message: "Invalid patternsPlayed." };

  const winnerRaw = payload.winner == null ? null : normalizeText(payload.winner, 12).toLowerCase();
  if (winnerRaw != null && !WINNER_SET.has(winnerRaw)) return { ok: false, message: "Invalid winner." };

  const startedAt = parseTimestamp(payload.startedAt, null);
  if (payload.startedAt != null && startedAt == null) return { ok: false, message: "Invalid startedAt." };

  const endedAt = parseTimestamp(payload.endedAt, new Date().toISOString());
  if (endedAt == null) return { ok: false, message: "Invalid endedAt." };

  const matchIdRaw = normalizeText(payload.matchId || "", MAX_MATCH_ID_LEN);
  const matchId = matchIdRaw || crypto.randomUUID();

  const playerName = normalizeText(payload.playerName || "You", MAX_NAME_LEN) || "You";
  const opponentNameRaw = payload.opponentName == null ? null : normalizeText(payload.opponentName, MAX_NAME_LEN);
  const opponentName = opponentNameRaw || null;

  let stats = null;
  if (payload.stats != null) {
    if (typeof payload.stats !== "object") return { ok: false, message: "Invalid stats." };
    const clicks = parseIntBounded(payload.stats.clicks, { min: 0, max: MAX_SCORE });
    const correct = parseIntBounded(payload.stats.correct, { min: 0, max: MAX_SCORE });
    const wrong = parseIntBounded(payload.stats.wrong, { min: 0, max: MAX_SCORE });
    if (clicks == null || correct == null || wrong == null) return { ok: false, message: "Invalid stats values." };
    if (correct + wrong > clicks) return { ok: false, message: "Invalid stats consistency." };
    stats = { clicks, correct, wrong };
  }

  return {
    ok: true,
    value: {
      matchId,
      mode,
      difficulty,
      duration,
      startedAt,
      endedAt,
      playerScore,
      botScore,
      winner: winnerRaw,
      patternsPlayed,
      playerName,
      opponentName,
      stats
    }
  };
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };
  return map[ext] || "application/octet-stream";
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": getContentType(filePath) });
    res.end(data);
  });
}

ensureStorage();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/match/end") {
    try {
      const body = await collectBody(req);
      const payload = JSON.parse(body || "{}");
      const parsed = sanitizeMatchPayload(payload);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, message: parsed.message });
        return;
      }

      const normalized = parsed.value;
      const incomingId = normalized.matchId;
      const ip = getClientIp(req);
      const userAgent = req.headers["user-agent"] || null;

      await enqueueWrite(async () => {
        const matches = await readMatches();
        const idx = incomingId ? matches.findIndex((m) => m.matchId === incomingId) : -1;

        if (idx >= 0) {
          matches[idx] = {
            ...matches[idx],
            ip: matches[idx].ip || ip,
            userAgent: matches[idx].userAgent || userAgent,
            playerName: normalized.playerName || matches[idx].playerName || "You",
            opponentName: normalized.opponentName == null ? (matches[idx].opponentName || null) : normalized.opponentName,
            mode: normalized.mode,
            difficulty: normalized.difficulty,
            duration: normalized.duration,
            startedAt: normalized.startedAt,
            endedAt: normalized.endedAt,
            playerScore: normalized.playerScore,
            botScore: normalized.botScore,
            winner: normalized.winner,
            patternsPlayed: normalized.patternsPlayed,
            stats: normalized.stats
          };
        } else {
          matches.push({
            matchId: incomingId,
            ip,
            userAgent,
            playerName: normalized.playerName,
            opponentName: normalized.opponentName,
            mode: normalized.mode,
            difficulty: normalized.difficulty,
            duration: normalized.duration,
            startedAt: normalized.startedAt,
            endedAt: normalized.endedAt,
            playerScore: normalized.playerScore,
            botScore: normalized.botScore,
            winner: normalized.winner,
            patternsPlayed: normalized.patternsPlayed,
            stats: normalized.stats
          });
        }

        await writeMatchesAtomic(matches);
      });

      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 400, { ok: false, message: "Invalid request payload." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/matches") {
    const matches = await readMatches();
    sendJson(res, 200, { ok: true, total: matches.length, matches });
    return;
  }

  if (req.method === "GET") {
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const normalized = path.normalize(pathname).replace(/^([\\/])+/, "");
    const filePath = path.join(ROOT_DIR, normalized);

    if (!filePath.startsWith(ROOT_DIR)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      sendFile(res, filePath);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Route not found");
});

server.listen(PORT, () => {
  console.log(`MindSnap server running at http://localhost:${PORT}`);
});
