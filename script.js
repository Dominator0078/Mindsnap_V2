"use strict";

// MindSnap Duels - Game Zone runtime (touch-first, end-of-match upload).

const PREVIEW_MS = 1500;
const BETWEEN_PATTERN_MS = 312;

const DIFFICULTY = {
  easy: { minGrid: 3, maxGrid: 5, density: 0.22 },
  medium: { minGrid: 4, maxGrid: 6, density: 0.24 },
  hard: { minGrid: 5, maxGrid: 7, density: 0.26 }
};

const BOT_BASE = {
  easy: { accuracy: 0.62, delayMin: 520, delayMax: 980 },
  medium: { accuracy: 0.72, delayMin: 380, delayMax: 760 },
  hard: { accuracy: 0.82, delayMin: 250, delayMax: 560 }
};

const params = new URLSearchParams(window.location.search);
const rawMode = params.get("mode");
const mode = rawMode === "duel" ? "duel" : rawMode === "pvp" ? "pvp" : "solo";
const difficultyKey = DIFFICULTY[params.get("difficulty")] ? params.get("difficulty") : "medium";
const rawDuration = Number(params.get("duration"));
const duration = Number.isFinite(rawDuration) ? clamp(Math.round(rawDuration), 60, 120) : 60;
const config = DIFFICULTY[difficultyKey];

const boardEl = document.getElementById("board");
const boardWrapEl = document.querySelector(".board-wrap");
const timerEl = document.getElementById("timer");
const modeLabelEl = document.getElementById("modeLabel");
const difficultyLabelEl = document.getElementById("difficultyLabel");
const playerScoreEl = document.getElementById("playerScore");
const botScoreEl = document.getElementById("botScore");
const botCardEl = document.getElementById("botCard");
const overlayEl = document.getElementById("overlay");
const resultModeEl = document.getElementById("resultMode");
const resultTitleEl = document.getElementById("resultTitle");
const resultBodyEl = document.getElementById("resultBody");
const restartBtn = document.getElementById("restartBtn");
const playAgainBtn = document.getElementById("playAgainBtn");

modeLabelEl.textContent = mode === "duel" ? "Duels (Bot)" : mode === "pvp" ? "Multiplayer" : "Solo";
difficultyLabelEl.textContent = difficultyKey[0].toUpperCase() + difficultyKey.slice(1);
if (mode === "solo") botCardEl.style.display = "none";

const playerNameKey = "mindsnap_name_v1";
const clientIdKey = "mindsnap_client_id_v1";
let localClientId = localStorage.getItem(clientIdKey) || "";
const localPlayerName = (localStorage.getItem(playerNameKey) || "You").trim() || "You";

if (!localClientId) {
  try {
    localClientId = crypto.randomUUID();
  } catch {
    localClientId = `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
  try {
    localStorage.setItem(clientIdKey, localClientId);
  } catch {
    /* ignore */
  }
}

const opponentNameEl = botCardEl?.querySelector("h2") || null;
const playerNameEl = document.querySelector(".score-card h2") || null;
if (playerNameEl && mode === "pvp") playerNameEl.textContent = localPlayerName;

boardEl?.addEventListener("contextmenu", (e) => e.preventDefault());

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function makeClientMatchId() {
  try {
    return crypto?.randomUUID?.() || `m_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  } catch {
    return `m_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function getGridSize(patternNumber) {
  const span = config.maxGrid - config.minGrid;
  const step = Math.min(span, Math.max(0, patternNumber - 1));
  return config.minGrid + step;
}

function getTargetCount(gridSize) {
  const total = gridSize * gridSize;
  return clamp(Math.round(total * config.density), 3, total - 1);
}

// Pre-allocated shuffle buffer (hard max grid is 7x7 = 49).
const MAX_GRID = 7;
const shuffleBuf = new Int32Array(MAX_GRID * MAX_GRID);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand32() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngForPattern(patternNumber) {
  if (!state?.pvp?.enabled) return Math.random;
  const seed = (state.pvp.seed ^ Math.imul(patternNumber, 0x9E3779B1)) >>> 0;
  return mulberry32(seed);
}

function fillPattern(totalTiles, count, outSet, rng) {
  outSet.clear();
  for (let i = 0; i < totalTiles; i += 1) shuffleBuf[i] = i;
  for (let i = totalTiles - 1; i > 0; i -= 1) {
    const j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
    const tmp = shuffleBuf[i];
    shuffleBuf[i] = shuffleBuf[j];
    shuffleBuf[j] = tmp;
  }
  for (let k = 0; k < count; k += 1) outSet.add(shuffleBuf[k]);
}

// Pools (avoid allocating Sets during the live match).
const pool = {
  targets: new Set(),
  found: new Set(),
  clicked: new Set(),
  reset() {
    this.targets.clear();
    this.found.clear();
    this.clicked.clear();
  }
};

const botPool = {
  targets: new Set(),
  reset() {
    this.targets.clear();
  }
};

// Match epoch: cancels all timeouts/rAF callbacks on restart.
let matchEpoch = 0;
const PENDING_END_KEY = "mindsnap_pending_end_v1";

let botWorker = null;
try {
  botWorker = new Worker("bot.worker.js");
  botWorker.onmessage = onWorkerMessage;
} catch {
  botWorker = null;
}

// Supabase (Multiplayer)
const SUPABASE_URL = "https://kqhgodyuzcxilurksigq.supabase.co";
const SUPABASE_KEY = "sb_publishable_vT7txYsSlcpDbOfOsuqh9Q_-aTrvWAU";

const state = {
  live: false,
  timeLeft: duration,
  rafId: null,
  lastTick: 0,
  tiles: [],
  reported: false,
  startedAt: null,
  endedAt: null,
  clientMatchId: null,
  pendingEndPayload: null,
  player: {
    totalScore: 0,
    patternCount: 0,
    current: null,
    pauseId: null,
    nextId: null,
    accepting: false
  },
  bot: {
    totalScore: 0,
    patternCount: 0,
    current: null,
    pauseId: null,
    clickId: null,
    nextId: null,
    workerEpoch: 0
  },
  telemetry: {
    clicks: 0,
    correct: 0,
    wrong: 0
  },
  pvp: {
    enabled: mode === "pvp",
    matchId: params.get("matchId") || null,
    seed: Number(params.get("seed") || 0) || 0,
    startAtMs: Number(params.get("startAt") || 0) || 0,
    channel: null,
    opponentId: null,
    opponentName: null,
    opponentScore: 0,
    opponentFinal: null,
    myFinal: null,
    scoreSendId: null,
    started: false
  }
};

function parsePlayerToken(token) {
  const raw = String(token || "");
  const [id, ...nameParts] = raw.split("|");
  return { clientId: id || null, name: (nameParts.join("|") || "").trim() || null };
}

if (state.pvp.enabled) {
  const p1 = parsePlayerToken(params.get("p1"));
  const p2 = parsePlayerToken(params.get("p2"));
  const meId = localClientId;

  const me = p1.clientId === meId ? p1 : p2.clientId === meId ? p2 : null;
  const opp = me === p1 ? p2 : me === p2 ? p1 : p1.clientId && p1.clientId !== meId ? p1 : p2;

  state.pvp.opponentId = opp?.clientId || null;
  state.pvp.opponentName = opp?.name || "Opponent";

  if (opponentNameEl) opponentNameEl.textContent = state.pvp.opponentName;
  if (botScoreEl) botScoreEl.textContent = "0";

  // In multiplayer, treat restart as exit.
  restartBtn.textContent = "Exit";
  playAgainBtn.textContent = "Back to Home";
}

function clearBoard() {
  boardEl.textContent = "";
  state.tiles = [];
}

function renderBoard(gridSize) {
  clearBoard();
  boardEl.style.setProperty("--size", String(gridSize));
  const total = gridSize * gridSize;
  const frag = document.createDocumentFragment();

  for (let i = 0; i < total; i += 1) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    tile.dataset.index = String(i);
    tile.addEventListener(
      "pointerdown",
      (e) => {
        e.preventDefault();
        onPlayerTileClick(i);
      },
      { passive: false }
    );
    frag.appendChild(tile);
    state.tiles.push(tile);
  }
  boardEl.appendChild(frag);
}

function setAllTilesDisabled(disabled) {
  state.player.accepting = !disabled;
  for (const tile of state.tiles) tile.disabled = disabled;
}

function showPreview(targets) {
  for (const idx of targets) state.tiles[idx]?.classList.add("preview");
}

function hidePreview() {
  for (const tile of state.tiles) tile.classList.remove("preview");
}

function resetTileMarks() {
  for (const tile of state.tiles) tile.classList.remove("correct", "wrong");
}

function updateHud() {
  timerEl.textContent = String(state.timeLeft);
  playerScoreEl.textContent = String(state.player.totalScore);
  botScoreEl.textContent = String(mode === "pvp" ? state.pvp.opponentScore : state.bot.totalScore);

  if (state.pvp.enabled && state.live) schedulePvPScoreSend();
}

function schedulePvPScoreSend() {
  if (!state.pvp.enabled || !state.pvp.channel) return;
  if (state.pvp.scoreSendId) return;
  state.pvp.scoreSendId = setTimeout(() => {
    state.pvp.scoreSendId = null;
    sendPvPScore();
  }, 250);
}

function sendPvPScore() {
  if (!state.pvp.enabled || !state.pvp.channel) return;
  state.pvp.channel.send({
    type: "broadcast",
    event: "score",
    payload: {
      matchId: state.pvp.matchId,
      clientId: localClientId,
      name: localPlayerName,
      score: state.player.totalScore,
      patternsPlayed: state.player.patternCount,
      timeLeft: state.timeLeft
    }
  });
}

function sendPvPFinal() {
  if (!state.pvp.enabled || !state.pvp.channel) return;
  state.pvp.myFinal = state.player.totalScore;
  state.pvp.channel.send({
    type: "broadcast",
    event: "final",
    payload: {
      matchId: state.pvp.matchId,
      clientId: localClientId,
      name: localPlayerName,
      score: state.player.totalScore
    }
  });
}

function endPvPBecauseLeft() {
  if (!state.pvp.enabled || !state.live) return;
  state.live = false;
  cancelAnimationFrame(state.rafId);
  clearTimeout(state.player.pauseId);
  clearTimeout(state.player.nextId);
  setAllTilesDisabled(true);
  setBoardLoading(false);

  resultModeEl.textContent = "Multiplayer Result";
  resultTitleEl.textContent = "Opponent Left";
  resultBodyEl.textContent = `Final score: ${state.player.totalScore}`;
  overlayEl.classList.add("show");

  state.endedAt = new Date().toISOString();
  stashPendingEnd(buildEndPayload());
  reportMatchEnd();
}

function initPvPRealtime() {
  if (!state.pvp.enabled || !state.pvp.matchId) return;
  if (state.pvp.channel) return;
  if (typeof supabase === "undefined") return;

  const { createClient } = supabase;
  const supa = createClient(SUPABASE_URL, SUPABASE_KEY);
  const channel = supa.channel(`mindsnap:match:${state.pvp.matchId}`, {
    config: {
      broadcast: { self: true, ack: false },
      presence: { key: localClientId }
    }
  });

  channel
    .on("broadcast", { event: "score" }, ({ payload }) => {
      if (!payload || payload.clientId === localClientId) return;
      state.pvp.opponentScore = Number(payload.score || 0);
      if (payload.name) {
        state.pvp.opponentName = String(payload.name);
        if (opponentNameEl) opponentNameEl.textContent = state.pvp.opponentName;
      }
      updateHud();
    })
    .on("broadcast", { event: "final" }, ({ payload }) => {
      if (!payload || payload.clientId === localClientId) return;
      state.pvp.opponentFinal = Number(payload.score || 0);
      state.pvp.opponentScore = state.pvp.opponentFinal;
      updateHud();
      if (!state.live && overlayEl.classList.contains("show")) {
        // Update winner text if overlay is already visible.
        const you = state.player.totalScore;
        const opp = state.pvp.opponentFinal;
        resultTitleEl.textContent = you === opp ? "Draw" : you > opp ? "You Win" : "You Lose";
        resultBodyEl.textContent = `You: ${you} | ${state.pvp.opponentName || "Opponent"}: ${opp}`;
      }
    })
    .on("broadcast", { event: "leave" }, ({ payload }) => {
      if (!payload || payload.clientId === localClientId) return;
      endPvPBecauseLeft();
    })
    .on("presence", { event: "leave" }, ({ leftPresences }) => {
      const left = Array.isArray(leftPresences) ? leftPresences : [];
      const oppId = state.pvp.opponentId;
      if (!oppId) return;
      if (left.some((m) => m?.clientId === oppId)) endPvPBecauseLeft();
    })
    .subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      await channel.track({ clientId: localClientId, name: localPlayerName, online_at: new Date().toISOString() });
    });

  // Best-effort: signal leave before unload (presence will also drop).
  document.addEventListener("pagehide", () => {
    channel.send({ type: "broadcast", event: "leave", payload: { clientId: localClientId } });
  });

  state.pvp.channel = channel;
}

function setBoardLoading(loading) {
  boardWrapEl?.classList.toggle("loading", loading);
}

// rAF timer (drift-safe even if a frame is dropped).
function startTimer() {
  cancelAnimationFrame(state.rafId);
  const epoch = matchEpoch;

  function tick(now) {
    if (!state.live || epoch !== matchEpoch) return;

    const delta = now - state.lastTick;
    if (delta >= 1000) {
      const seconds = Math.floor(delta / 1000);
      state.timeLeft = Math.max(0, state.timeLeft - seconds);
      state.lastTick += seconds * 1000;
      updateHud();
      if (state.timeLeft <= 0) {
        endMatch();
        return;
      }
    }
    state.rafId = requestAnimationFrame(tick);
  }

  state.rafId = requestAnimationFrame((now) => {
    if (epoch !== matchEpoch) return;
    state.lastTick = now;
    state.rafId = requestAnimationFrame(tick);
  });
}

function createPatternState(patternNumber) {
  const gridSize = getGridSize(patternNumber);
  const totalTiles = gridSize * gridSize;
  const targetCount = getTargetCount(gridSize);

  pool.reset();
  fillPattern(totalTiles, targetCount, pool.targets, rngForPattern(patternNumber));

  return {
    patternNumber,
    gridSize,
    targets: pool.targets,
    found: pool.found,
    clicked: pool.clicked,
    clickLimit: targetCount,
    clicksUsed: 0,
    rawScore: 0,
    done: false
  };
}

function startPlayerPattern() {
  if (!state.live) return;
  const epoch = matchEpoch;

  setBoardLoading(false);
  state.player.patternCount += 1;

  const current = createPatternState(state.player.patternCount);
  state.player.current = current;

  renderBoard(current.gridSize);
  resetTileMarks();
  setAllTilesDisabled(true);
  showPreview(current.targets);
  updateHud();

  setTimeout(() => {
    if (!state.live || epoch !== matchEpoch || state.player.current !== current) return;
    hidePreview();
    setAllTilesDisabled(false);
  }, PREVIEW_MS);
}

function finishPlayerPattern() {
  const current = state.player.current;
  if (!state.live || !current || current.done) return;

  current.done = true;
  state.player.totalScore += Math.max(0, current.rawScore);
  updateHud();
  setAllTilesDisabled(true);
  setBoardLoading(true);

  clearTimeout(state.player.pauseId);
  clearTimeout(state.player.nextId);
  state.player.pauseId = setTimeout(() => {
    resetTileMarks();
    state.player.nextId = setTimeout(() => {
      if (state.live) startPlayerPattern();
    }, 0);
  }, BETWEEN_PATTERN_MS);
}

function onPlayerTileClick(index) {
  const current = state.player.current;
  if (!state.live || !current) return;
  if (!state.player.accepting) return;
  if (current.clicksUsed >= current.clickLimit) return;
  if (current.clicked.has(index)) return;

  current.clicked.add(index);
  current.clicksUsed += 1;
  state.telemetry.clicks += 1;

  const tile = state.tiles[index];
  if (!tile) return;

  if (current.targets.has(index)) {
    current.found.add(index);
    current.rawScore += 2;
    tile.classList.add("correct");
    state.telemetry.correct += 1;
  } else {
    current.rawScore -= 1;
    tile.classList.add("wrong");
    state.telemetry.wrong += 1;
  }

  updateHud();
  if (current.clicksUsed >= current.clickLimit) finishPlayerPattern();
}

function getBotProfile() {
  const base = BOT_BASE[difficultyKey];
  let accuracy = base.accuracy + rand(-0.08, 0.08);
  let delayMin = base.delayMin + rand(-110, 90);
  let delayMax = base.delayMax + rand(-120, 120);

  const gap = state.player.totalScore - state.bot.totalScore;
  const urgency = clamp(gap / 40, -1, 1);
  const lateGame = state.timeLeft <= Math.floor(duration * 0.35);

  accuracy += urgency * 0.07;
  delayMin -= urgency * 90;
  delayMax -= urgency * 120;

  if (lateGame) {
    accuracy += 0.03;
    delayMin -= 35;
    delayMax -= 50;
  }

  return {
    accuracy: clamp(accuracy, 0.42, 0.95),
    delayMin: clamp(Math.round(delayMin), 140, 1400),
    delayMax: clamp(Math.round(Math.max(delayMin + 70, delayMax)), 230, 1800)
  };
}

function startBotPattern() {
  if (!state.live || mode !== "duel") return;
  const epoch = matchEpoch;

  state.bot.patternCount += 1;
  const gridSize = getGridSize(state.bot.patternCount);
  const totalTiles = gridSize * gridSize;
  const targetCount = getTargetCount(gridSize);

  botPool.reset();
  fillPattern(totalTiles, targetCount, botPool.targets, Math.random);

  const profile = getBotProfile();
  state.bot.current = {
    rawScore: 0,
    clicksUsed: 0,
    clickLimit: targetCount,
    done: false
  };
  updateHud();

  setTimeout(() => {
    if (!state.live || epoch !== matchEpoch) return;
    if (!state.bot.current || state.bot.current.done) return;

    state.bot.workerEpoch += 1;
    const workerEpoch = state.bot.workerEpoch;

    if (botWorker) {
      botWorker.postMessage({
        type: "start",
        epoch: workerEpoch,
        pattern: {
          targets: Array.from(botPool.targets),
          clickLimit: targetCount,
          profile
        }
      });
    } else {
      inlineBotSimulate(profile, Array.from(botPool.targets), targetCount, workerEpoch);
    }
  }, PREVIEW_MS);
}

function onWorkerMessage(e) {
  const msg = e.data;
  const current = state.bot.current;
  if (!state.live || mode !== "duel" || !current || current.done) return;
  if (msg?.epoch !== state.bot.workerEpoch) return;

  if (msg.type === "click") {
    current.rawScore += msg.hit ? 2 : -1;
    current.clicksUsed += 1;
    updateHud();
  }

  if (msg.type === "done" || current.clicksUsed >= current.clickLimit) finishBotPattern();
}

function finishBotPattern() {
  const current = state.bot.current;
  if (!state.live || !current || current.done) return;

  current.done = true;
  state.bot.totalScore += Math.max(0, current.rawScore);
  updateHud();

  clearTimeout(state.bot.pauseId);
  clearTimeout(state.bot.nextId);
  clearTimeout(state.bot.clickId);

  state.bot.pauseId = setTimeout(() => {
    state.bot.nextId = setTimeout(() => {
      if (state.live && mode === "duel") startBotPattern();
    }, 0);
  }, BETWEEN_PATTERN_MS);
}

function buildEndPayload() {
  const you = state.player.totalScore;
  const otherScore = mode === "pvp" ? state.pvp.opponentScore : state.bot.totalScore;
  const winner =
    mode === "solo"
      ? "you"
      : you === otherScore
        ? "draw"
        : you > otherScore
          ? "you"
          : mode === "pvp"
            ? "opponent"
            : "bot";

  return {
    matchId: state.clientMatchId,
    mode,
    difficulty: difficultyKey,
    duration,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    playerScore: you,
    botScore: mode === "solo" ? null : otherScore,
    winner,
    patternsPlayed: state.player.patternCount,
    stats: {
      clicks: state.telemetry.clicks,
      correct: state.telemetry.correct,
      wrong: state.telemetry.wrong
    }
  };
}

function stashPendingEnd(payload) {
  state.pendingEndPayload = payload;
  try {
    localStorage.setItem(PENDING_END_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function clearPendingEnd() {
  state.pendingEndPayload = null;
  try {
    localStorage.removeItem(PENDING_END_KEY);
  } catch {
    /* ignore */
  }
}

async function flushPendingFromStorage() {
  try {
    const raw = localStorage.getItem(PENDING_END_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (!payload?.endedAt) return;

    const res = await fetch("/api/match/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return;

    localStorage.removeItem(PENDING_END_KEY);
  } catch {
    /* ignore */
  }
}

async function reportMatchEnd() {
  if (state.reported || !state.pendingEndPayload) return;
  state.reported = true;
  try {
    const res = await fetch("/api/match/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.pendingEndPayload)
    });
    if (!res.ok) throw new Error("Bad status");
    clearPendingEnd();
  } catch {
    state.reported = false;
  }
}

function endMatch() {
  if (!state.live) return;
  state.live = false;

  cancelAnimationFrame(state.rafId);
  clearTimeout(state.player.pauseId);
  clearTimeout(state.player.nextId);
  clearTimeout(state.bot.pauseId);
  clearTimeout(state.bot.nextId);
  clearTimeout(state.bot.clickId);
  botWorker?.postMessage({ type: "stop" });
  setAllTilesDisabled(true);
  setBoardLoading(false);

  if (mode === "duel") {
    resultModeEl.textContent = "Duel Result";
    const you = state.player.totalScore;
    const bot = state.bot.totalScore;
    resultTitleEl.textContent = you === bot ? "Draw" : you > bot ? "You Win" : "Bot Wins";
    resultBodyEl.textContent = `You: ${you} | Bot: ${bot}`;
  } else if (mode === "pvp") {
    resultModeEl.textContent = "Multiplayer Result";
    sendPvPFinal();

    const you = state.player.totalScore;
    const opp = state.pvp.opponentFinal != null ? state.pvp.opponentFinal : state.pvp.opponentScore;
    resultTitleEl.textContent = you === opp ? "Draw" : you > opp ? "You Win" : "You Lose";
    resultBodyEl.textContent = `You: ${you} | ${state.pvp.opponentName || "Opponent"}: ${opp}`;
  } else {
    resultModeEl.textContent = "Solo Result";
    resultTitleEl.textContent = "Time Up";
    resultBodyEl.textContent = `Final score: ${state.player.totalScore}`;
  }

  overlayEl.classList.add("show");

  // Queue and send ONLY after match end.
  state.endedAt = new Date().toISOString();
  stashPendingEnd(buildEndPayload());
  reportMatchEnd();
}

function resetMatch() {
  // If the previous match ended but couldn't upload, retry now (without waiting for a page reload).
  flushPendingFromStorage();

  matchEpoch += 1;
  botWorker?.postMessage({ type: "stop" });

  cancelAnimationFrame(state.rafId);
  clearTimeout(state.player.pauseId);
  clearTimeout(state.player.nextId);
  clearTimeout(state.bot.pauseId);
  clearTimeout(state.bot.nextId);
  clearTimeout(state.bot.clickId);

  initPvPRealtime();

  state.live = mode !== "pvp";
  state.timeLeft = duration;
  state.reported = false;
  state.startedAt = mode === "pvp" && state.pvp.startAtMs
    ? new Date(state.pvp.startAtMs).toISOString()
    : new Date().toISOString();
  state.endedAt = null;
  state.clientMatchId = mode === "pvp" && state.pvp.matchId ? state.pvp.matchId : makeClientMatchId();
  state.pendingEndPayload = null;

  state.player.totalScore = 0;
  state.player.patternCount = 0;
  state.player.current = null;
  state.player.accepting = false;

  state.bot.totalScore = 0;
  state.bot.patternCount = 0;
  state.bot.current = null;
  state.bot.workerEpoch += 1;

  state.telemetry.clicks = 0;
  state.telemetry.correct = 0;
  state.telemetry.wrong = 0;

  overlayEl.classList.remove("show");
  setBoardLoading(false);
  updateHud();

  if (mode === "pvp") {
    // Wait until the synchronized start timestamp.
    const delay = Math.max(0, state.pvp.startAtMs - Date.now());
    setAllTilesDisabled(true);
    setTimeout(() => {
      if (mode !== "pvp") return;
      state.live = true;
      state.pvp.started = true;
      startTimer();
      startPlayerPattern();
      updateHud();
    }, delay);
    return;
  }

  startTimer();
  startPlayerPattern();
  if (mode === "duel") startBotPattern();
}

function beaconEndIfNeeded() {
  if (state.reported || !state.pendingEndPayload) return;
  try {
    const blob = new Blob([JSON.stringify(state.pendingEndPayload)], { type: "application/json" });
    navigator.sendBeacon?.("/api/match/end", blob);
  } catch {
    /* ignore */
  }
}

document.addEventListener("pagehide", beaconEndIfNeeded);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") beaconEndIfNeeded();
});

// Reduce accidental exits: trap browser back during a live match.
try {
  history.pushState({ mindsnap: true }, "", location.href);
  window.addEventListener("popstate", () => {
    if (state.live) history.pushState({ mindsnap: true }, "", location.href);
  });
} catch {
  /* ignore */
}

// Best-effort close/refresh warning (mobile support varies).
window.addEventListener("beforeunload", (e) => {
  if (!state.live) return;
  e.preventDefault();
  e.returnValue = "";
});

flushPendingFromStorage();

function exitToHome() {
  try {
    state.pvp.channel?.send({ type: "broadcast", event: "leave", payload: { clientId: localClientId } });
  } catch {
    /* ignore */
  }
  window.location.href = "index.html";
}

restartBtn.addEventListener("click", mode === "pvp" ? exitToHome : resetMatch);
playAgainBtn.addEventListener("click", mode === "pvp" ? exitToHome : resetMatch);
resetMatch();

// Inline bot fallback (kept minimal).
function inlineBotSimulate(profile, targets, clickLimit, workerEpoch) {
  const capturedEpoch = matchEpoch;
  const current = state.bot.current;
  let clicks = 0;
  let hitsMade = 0;
  const plannedHits = Math.max(
    0,
    Math.min(
      clickLimit,
      Math.round(clickLimit * Number(profile.accuracy || 0)) + (Math.random() < 0.5 ? 0 : 1)
    )
  );
  const remaining = targets.slice();

  function step() {
    if (!state.live || mode !== "duel" || capturedEpoch !== matchEpoch) return;
    if (workerEpoch !== state.bot.workerEpoch) return;
    if (!state.bot.current || state.bot.current !== current || current.done) return;
    if (clicks >= clickLimit) {
      finishBotPattern();
      return;
    }

    const remainingClicks = Math.max(1, clickLimit - clicks);
    const remainingHits = Math.max(0, plannedHits - hitsMade);
    const hit = remainingHits > 0 && Math.random() < remainingHits / remainingClicks;
    if (hit && remaining.length > 0) {
      const pickIdx = Math.floor(Math.random() * remaining.length);
      remaining[pickIdx] = remaining[remaining.length - 1];
      remaining.pop();
      current.rawScore += 2;
      hitsMade += 1;
    } else {
      current.rawScore -= 1;
    }
    clicks += 1;
    current.clicksUsed += 1;
    updateHud();

    if (clicks >= clickLimit) {
      finishBotPattern();
      return;
    }

    const delay = Math.round(rand(profile.delayMin, profile.delayMax));
    state.bot.clickId = setTimeout(step, delay);
  }

  state.bot.clickId = setTimeout(step, 0);
}
