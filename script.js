const { createClient } = window.supabase || {};
// Module scripts are strict by default.

// MindSnap Duels - Game Zone runtime (touch-first, end-of-match upload).

const PREVIEW_MS = 1500;
const BETWEEN_PATTERN_MS = 312;
const PVP_START_COUNTDOWN_SEC = 3;
const RESULT_REDIRECT_MS = 3000;

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
const storageWarnings = new Set();

function warnStorage(area, err) {
  if (storageWarnings.has(area)) return;
  storageWarnings.add(area);
  console.warn(`[Storage] ${area} unavailable; using in-memory fallback.`, err?.name || err);
}

function safeGet(storage, key, area) {
  try {
    return storage.getItem(key);
  } catch (err) {
    warnStorage(area, err);
    return null;
  }
}

function safeSet(storage, key, value, area) {
  try {
    storage.setItem(key, value);
    return true;
  } catch (err) {
    warnStorage(area, err);
    return false;
  }
}

function safeRemove(storage, key, area) {
  try {
    storage.removeItem(key);
    return true;
  } catch (err) {
    warnStorage(area, err);
    return false;
  }
}

const boardEl = document.getElementById("board");
const boardResultEl = document.getElementById("boardResult");
const boardResultTitleEl = document.getElementById("boardResultTitle");
const resultTableBodyEl = document.getElementById("resultTableBody");
const backCountdownEl = document.getElementById("backCountdown");
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
let localClientId = safeGet(sessionStorage, clientIdKey, "session/clientId-read")
  || safeGet(localStorage, clientIdKey, "local/clientId-read")
  || "";
const localPlayerName = (safeGet(localStorage, playerNameKey, "local/playerName-read") || "You").trim() || "You";

if (!localClientId) {
  try {
    localClientId = crypto.randomUUID();
  } catch {
    localClientId = `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
  safeSet(sessionStorage, clientIdKey, localClientId, "session/clientId-write");
  safeSet(localStorage, clientIdKey, localClientId, "local/clientId-write");
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
let supaClient = null;

const state = {
  live: false,
  timeLeft: duration,
  deadlineMs: 0,
  rafId: null,
  hardEndId: null,
  lastTick: 0,
  tiles: [],
  reported: false,
  startedAt: null,
  endedAt: null,
  clientMatchId: null,
  pendingEndPayload: null,
  returnHomeId: null,
  returnHomeTickId: null,
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
    opponentPatternNumber: 0,
    opponentFinal: null,
    myFinal: null,
    countdownId: null,
    startTimeoutId: null,
    started: false
  }
};

// Expose a tiny debug surface for debug_module.js (module scope isn't global).
window.__mindsnap = {
  get mode() {
    return mode;
  },
  get state() {
    return state;
  },
  get localClientId() {
    return localClientId;
  },
  get localPlayerName() {
    return localPlayerName;
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
}

function sendPvPScoreUpdate({ patternNumber } = {}) {
  if (!state.pvp.enabled || !state.pvp.channel) return;
  const payload = {
    matchId: state.pvp.matchId,
    fromUserId: localClientId,
    name: localPlayerName,
    opponentTotalScore: state.player.totalScore,
    opponentPatternNumber: Number.isFinite(patternNumber) ? patternNumber : state.player.patternCount,
    at: Date.now()
  };

  state.pvp.channel.send({
    type: "broadcast",
    event: "score_update",
    payload
  });
}

function sendPvPFinal() {
  if (!state.pvp.enabled || !state.pvp.channel) return;
  state.pvp.myFinal = state.player.totalScore;
  const payload = {
    matchId: state.pvp.matchId,
    fromUserId: localClientId,
    name: localPlayerName,
    finalTotalScore: state.player.totalScore,
    at: Date.now()
  };

  state.pvp.channel.send({
    type: "broadcast",
    event: "match_end",
    payload
  });
}

function hideBoardResult() {
  if (!boardResultEl || !boardEl) return;
  boardResultEl.hidden = true;
  boardEl.hidden = false;
  if (resultTableBodyEl) resultTableBodyEl.textContent = "";
}

function showBoardResult({ title, rows }) {
  if (!boardResultEl || !boardEl || !boardResultTitleEl || !resultTableBodyEl) return;
  setAllTilesDisabled(true);
  boardEl.hidden = true;
  boardResultEl.hidden = false;
  boardResultTitleEl.textContent = title;
  resultTableBodyEl.textContent = "";

  for (const row of rows) {
    const tr = document.createElement("tr");
    const playerCell = document.createElement("td");
    const pointsCell = document.createElement("td");
    playerCell.textContent = row.name;
    pointsCell.textContent = String(row.points);
    tr.appendChild(playerCell);
    tr.appendChild(pointsCell);
    resultTableBodyEl.appendChild(tr);
  }
}

function scheduleReturnHome(seconds = 3) {
  clearTimeout(state.returnHomeId);
  clearInterval(state.returnHomeTickId);

  let secondsLeft = Math.max(1, Number(seconds) || 3);
  if (backCountdownEl) {
    backCountdownEl.textContent = `Going back to home in ${secondsLeft} second${secondsLeft === 1 ? "" : "s"}...`;
  }

  state.returnHomeTickId = setInterval(() => {
    secondsLeft -= 1;
    if (backCountdownEl) {
      backCountdownEl.textContent = `Going back to home in ${Math.max(0, secondsLeft)} second${secondsLeft === 1 ? "" : "s"}...`;
    }
    if (secondsLeft <= 0) {
      clearInterval(state.returnHomeTickId);
      state.returnHomeTickId = null;
    }
  }, 1000);

  state.returnHomeId = setTimeout(() => {
    window.location.href = "index.html";
  }, Math.max(RESULT_REDIRECT_MS, seconds * 1000));
}

function endPvPBecauseLeft() {
  if (!state.pvp.enabled) return;
  state.live = false;
  state.pvp.started = false;
  clearTimeout(state.hardEndId);
  clearTimeout(state.pvp.countdownId);
  clearTimeout(state.pvp.startTimeoutId);
  cancelAnimationFrame(state.rafId);
  clearTimeout(state.player.pauseId);
  clearTimeout(state.player.nextId);
  setAllTilesDisabled(true);
  setBoardLoading(false);
  overlayEl.classList.remove("show");

  showBoardResult({
    title: "Opponent Left",
    rows: [
      { name: localPlayerName, points: state.player.totalScore },
      { name: state.pvp.opponentName || "Opponent", points: state.pvp.opponentScore }
    ]
  });
  scheduleReturnHome();

  state.endedAt = new Date().toISOString();
  stashPendingEnd(buildEndPayload());
  reportMatchEnd();
}

function initPvPRealtime() {
  if (!state.pvp.enabled || !state.pvp.matchId) return;
  if (state.pvp.channel) return;
  if (typeof createClient !== "function") {
    console.warn("[MP] Supabase SDK not loaded; PvP realtime unavailable.");
    return;
  }
  if (!supaClient) {
    // Disable auth session persistence to avoid storage access being blocked by tracking protection.
    supaClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
  }
  const supa = supaClient;
  const channel = supa.channel(`mindsnap:match:${state.pvp.matchId}`, {
    config: {
      broadcast: { self: true, ack: false },
      presence: { key: localClientId }
    }
  });

  channel
    .on("broadcast", { event: "score_update" }, ({ payload }) => {
      if (!payload) return;
      const from = payload.fromUserId;
      if (from === localClientId) return;
      if (state.pvp.opponentId && from && from !== state.pvp.opponentId) return;

      const total = Number(payload.opponentTotalScore);
      if (!Number.isFinite(total)) return;

      const pn = Number(payload.opponentPatternNumber ?? 0);
      if (Number.isFinite(pn) && pn > 0) {
        if (pn < (state.pvp.opponentPatternNumber || 0)) return;
        state.pvp.opponentPatternNumber = pn;
      }

      if (payload.name) {
        state.pvp.opponentName = String(payload.name);
        if (opponentNameEl) opponentNameEl.textContent = state.pvp.opponentName;
      }

      state.pvp.opponentScore = Math.max(state.pvp.opponentScore || 0, total);
      updateHud();
    })
    .on("broadcast", { event: "match_end" }, ({ payload }) => {
      if (!payload) return;
      const from = payload.fromUserId;
      if (from === localClientId) return;
      if (state.pvp.opponentId && from && from !== state.pvp.opponentId) return;

      const final = Number(payload.finalTotalScore);
      if (!Number.isFinite(final)) return;
      state.pvp.opponentFinal = final;
      state.pvp.opponentScore = Math.max(state.pvp.opponentScore || 0, final);
      updateHud();
      if (!state.live && !boardResultEl.hidden) {
        const you = state.player.totalScore;
        const opp = state.pvp.opponentFinal;
        const oppName = state.pvp.opponentName || "Opponent";
        boardResultTitleEl.textContent = you === opp ? "Draw" : you > opp ? `${localPlayerName} Wins` : `${oppName} Wins`;
      }
    })
    .on("broadcast", { event: "leave" }, ({ payload }) => {
      if (!payload || payload.fromUserId === localClientId) return;
      endPvPBecauseLeft();
    })
    .on("presence", { event: "leave" }, ({ leftPresences }) => {
      const left = Array.isArray(leftPresences) ? leftPresences : [];
      const oppId = state.pvp.opponentId;
      if (!oppId) return;
      if (left.some((m) => m?.clientId === oppId)) endPvPBecauseLeft();
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ clientId: localClientId, name: localPlayerName, online_at: new Date().toISOString() });
        return;
      }
      if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
        console.warn("[MP] match channel status", status);
        if (state.live) {
          state.live = false;
          clearTimeout(state.hardEndId);
          clearTimeout(state.pvp.countdownId);
          clearTimeout(state.pvp.startTimeoutId);
          cancelAnimationFrame(state.rafId);
          setAllTilesDisabled(true);
          setBoardLoading(false);
          overlayEl.classList.remove("show");

          showBoardResult({
            title: "Connection Error",
            rows: [
              { name: localPlayerName, points: state.player.totalScore },
              { name: state.pvp.opponentName || "Opponent", points: state.pvp.opponentScore }
            ]
          });
          scheduleReturnHome();
        }
      }
    });

  // Best-effort: signal leave before unload (presence will also drop).
  document.addEventListener("pagehide", () => {
    channel.send({ type: "broadcast", event: "leave", payload: { fromUserId: localClientId } });
  });

  state.pvp.channel = channel;
}

function setBoardLoading(loading) {
  boardWrapEl?.classList.toggle("loading", loading);
}

function syncHudTimerFromDeadline() {
  const remainingMs = state.deadlineMs - Date.now();
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (seconds !== state.timeLeft) {
    state.timeLeft = seconds;
    updateHud();
  }
  return remainingMs;
}

function scheduleHardEnd() {
  clearTimeout(state.hardEndId);
  const delay = Math.max(0, state.deadlineMs - Date.now());
  state.hardEndId = setTimeout(() => {
    if (state.live) endMatch();
  }, delay + 10);
}

function showPvPStartCountdown(startAtMs) {
  clearTimeout(state.pvp.countdownId);
  overlayEl.classList.add("show");
  resultModeEl.textContent = "Multiplayer";
  resultTitleEl.textContent = "Get Ready";
  playAgainBtn.style.display = "none";

  const epoch = matchEpoch;
  const tick = () => {
    if (epoch !== matchEpoch || mode !== "pvp") return;
    const leftMs = startAtMs - Date.now();
    const leftSec = Math.max(0, Math.ceil(leftMs / 1000));
    resultBodyEl.textContent = leftMs > 0 ? `Starting in ${leftSec}...` : "Go!";
    timerEl.textContent = leftMs > 0 ? String(leftSec) : String(duration);
    if (leftMs <= 0) return;
    state.pvp.countdownId = setTimeout(tick, 90);
  };
  tick();
}

// rAF timer (drift-safe even if a frame is dropped).
function startTimer() {
  cancelAnimationFrame(state.rafId);
  const epoch = matchEpoch;

  function tick() {
    if (!state.live || epoch !== matchEpoch) return;
    const remainingMs = syncHudTimerFromDeadline();
    if (remainingMs <= 0) {
      endMatch();
      return;
    }
    state.rafId = requestAnimationFrame(tick);
  }

  syncHudTimerFromDeadline();
  state.rafId = requestAnimationFrame(tick);
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
  if (state.pvp.enabled) sendPvPScoreUpdate({ patternNumber: current.patternNumber });
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
    playerName: localPlayerName,
    opponentName: mode === "pvp" ? (state.pvp.opponentName || null) : mode === "duel" ? "Bot" : null,
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
  safeSet(localStorage, PENDING_END_KEY, JSON.stringify(payload), "local/pending-write");
}

function clearPendingEnd() {
  state.pendingEndPayload = null;
  safeRemove(localStorage, PENDING_END_KEY, "local/pending-remove");
}

async function flushPendingFromStorage() {
  try {
    const raw = safeGet(localStorage, PENDING_END_KEY, "local/pending-read");
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (!payload?.endedAt) return;

    const res = await fetch("/api/match/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return;

    safeRemove(localStorage, PENDING_END_KEY, "local/pending-remove");
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

  clearTimeout(state.hardEndId);
  clearTimeout(state.pvp.countdownId);
  clearTimeout(state.pvp.startTimeoutId);
  cancelAnimationFrame(state.rafId);
  clearTimeout(state.player.pauseId);
  clearTimeout(state.player.nextId);
  clearTimeout(state.bot.pauseId);
  clearTimeout(state.bot.nextId);
  clearTimeout(state.bot.clickId);
  botWorker?.postMessage({ type: "stop" });
  setAllTilesDisabled(true);
  setBoardLoading(false);

  let title = "Result";
  const rows = [];

  if (mode === "duel") {
    const you = state.player.totalScore;
    const bot = state.bot.totalScore;
    title = you === bot ? "Draw" : you > bot ? `${localPlayerName} Wins` : "Bot Wins";
    rows.push({ name: localPlayerName, points: you }, { name: "Bot", points: bot });
  } else if (mode === "pvp") {
    sendPvPFinal();
    const you = state.player.totalScore;
    const oppName = state.pvp.opponentName || "Opponent";
    const opp = state.pvp.opponentFinal != null ? state.pvp.opponentFinal : state.pvp.opponentScore;
    title = you === opp ? "Draw" : you > opp ? `${localPlayerName} Wins` : `${oppName} Wins`;
    rows.push({ name: localPlayerName, points: you }, { name: oppName, points: opp });
  } else {
    const you = state.player.totalScore;
    title = `${localPlayerName} Wins`;
    rows.push({ name: localPlayerName, points: you });
  }

  showBoardResult({ title, rows });
  scheduleReturnHome(3);

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
  clearTimeout(state.hardEndId);
  clearTimeout(state.pvp.countdownId);
  clearTimeout(state.pvp.startTimeoutId);
  clearTimeout(state.returnHomeId);
  clearInterval(state.returnHomeTickId);
  state.returnHomeTickId = null;
  clearTimeout(state.player.pauseId);
  clearTimeout(state.player.nextId);
  clearTimeout(state.bot.pauseId);
  clearTimeout(state.bot.nextId);
  clearTimeout(state.bot.clickId);

  initPvPRealtime();

  state.live = mode !== "pvp";
  state.timeLeft = duration;
  state.deadlineMs = 0;
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
  state.pvp.started = false;

  state.bot.totalScore = 0;
  state.bot.patternCount = 0;
  state.bot.current = null;
  state.bot.workerEpoch += 1;

  state.telemetry.clicks = 0;
  state.telemetry.correct = 0;
  state.telemetry.wrong = 0;

  overlayEl.classList.remove("show");
  playAgainBtn.style.display = "";
  hideBoardResult();
  setBoardLoading(false);
  updateHud();

  if (mode === "pvp") {
    // Wait until the synchronized start timestamp and show 3..2..1 countdown.
    const fallbackStart = Date.now() + PVP_START_COUNTDOWN_SEC * 1000;
    const startAtMs = Number(state.pvp.startAtMs) > 0 ? Number(state.pvp.startAtMs) : fallbackStart;
    const delay = Math.max(0, startAtMs - Date.now());
    state.pvp.startAtMs = startAtMs;
    state.startedAt = new Date(startAtMs).toISOString();
    setAllTilesDisabled(true);
    showPvPStartCountdown(startAtMs);
    state.pvp.startTimeoutId = setTimeout(() => {
      if (mode !== "pvp") return;
      overlayEl.classList.remove("show");
      playAgainBtn.style.display = "";
      state.live = true;
      state.pvp.started = true;
      state.deadlineMs = startAtMs + duration * 1000;
      scheduleHardEnd();
      startTimer();
      startPlayerPattern();
      updateHud();
    }, delay);
    return;
  }

  state.deadlineMs = Date.now() + duration * 1000;
  scheduleHardEnd();
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
  clearTimeout(state.returnHomeId);
  clearInterval(state.returnHomeTickId);
  state.returnHomeTickId = null;
  try {
    state.pvp.channel?.send({ type: "broadcast", event: "leave", payload: { fromUserId: localClientId } });
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
