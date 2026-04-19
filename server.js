const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const MATCH_FILE = path.join(DATA_DIR, "matches.json");
const fsp = fs.promises;

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

async function writeMatches(matches) {
  await fsp.writeFile(MATCH_FILE, JSON.stringify(matches, null, 2), "utf8");
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

  if (req.method === "POST" && url.pathname === "/api/match/start") {
    try {
      const body = await collectBody(req);
      const payload = JSON.parse(body || "{}");

      const matchId = crypto.randomUUID();
      await enqueueWrite(async () => {
        const match = {
          matchId,
          ip: getClientIp(req),
          userAgent: req.headers["user-agent"] || null,
          mode: String(payload.mode || "solo"),
          difficulty: String(payload.difficulty || "medium"),
          duration: Number(payload.duration || 60),
          startedAt: payload.startedAt || new Date().toISOString(),
          endedAt: null,
          playerScore: null,
          botScore: null,
          winner: null,
          patternsPlayed: null,
          stats: null
        };

        const matches = await readMatches();
        matches.push(match);
        await writeMatches(matches);
      });

      sendJson(res, 200, { ok: true, matchId });
    } catch {
      sendJson(res, 400, { ok: false, message: "Invalid request payload." });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/match/end") {
    try {
      const body = await collectBody(req);
      const payload = JSON.parse(body || "{}");
      const incomingId = String(payload.matchId || "").trim();
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
            endedAt: payload.endedAt || new Date().toISOString(),
            playerScore: Number(payload.playerScore || 0),
            botScore: payload.botScore == null ? null : Number(payload.botScore),
            winner: payload.winner == null ? null : String(payload.winner),
            patternsPlayed: Number(payload.patternsPlayed || 0),
            stats: payload.stats || null
          };
        } else {
          matches.push({
            matchId: incomingId || crypto.randomUUID(),
            ip,
            userAgent,
            mode: String(payload.mode || "solo"),
            difficulty: String(payload.difficulty || "medium"),
            duration: Number(payload.duration || 60),
            startedAt: payload.startedAt || null,
            endedAt: payload.endedAt || new Date().toISOString(),
            playerScore: Number(payload.playerScore || 0),
            botScore: payload.botScore == null ? null : Number(payload.botScore),
            winner: payload.winner == null ? null : String(payload.winner),
            patternsPlayed: Number(payload.patternsPlayed || 0),
            stats: payload.stats || null
          });
        }

        await writeMatches(matches);
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
