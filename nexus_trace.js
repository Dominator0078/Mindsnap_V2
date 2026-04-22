const { createClient } = window.supabase || {};

const SUPABASE_URL = "https://kqhgodyuzcxilurksigq.supabase.co";
const SUPABASE_KEY = "sb_publishable_vT7txYsSlcpDbOfOsuqh9Q_-aTrvWAU";
const NAME_KEY = "mindsnap_name_v1";
const CLIENT_KEY = "mindsnap_client_id_v1";
const PENDING_END_KEY = "nexus_pending_end_v1";
const MATCH_MS = 60_000;
const SNAPSHOT_MS = 100;
const RETURN_HOME_SECONDS = 3;

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "pvp" ? "pvp" : "solo";
const blindEnabled = params.get("blind") === "1";
const matchIdFromUrl = params.get("matchId") || null;
const startAtFromUrl = Number(params.get("startAt") || 0) || 0;
const seedFromUrl = Number(params.get("seed") || 0) || 0;

const canvasEl = document.getElementById("nexusCanvas");
const modeLabelEl = document.getElementById("modeLabel");
const timerLabelEl = document.getElementById("timerLabel");
const roundLabelEl = document.getElementById("roundLabel");
const blindLabelEl = document.getElementById("blindLabel");
const playerNameLabelEl = document.getElementById("playerNameLabel");
const playerScoreLabelEl = document.getElementById("playerScoreLabel");
const opponentCardEl = document.getElementById("opponentCard");
const opponentNameLabelEl = document.getElementById("opponentNameLabel");
const opponentScoreLabelEl = document.getElementById("opponentScoreLabel");
const waitingLayerEl = document.getElementById("waitingLayer");
const waitingTitleEl = document.getElementById("waitingTitle");
const waitingSubEl = document.getElementById("waitingSub");
const resultLayerEl = document.getElementById("resultLayer");
const resultTitleEl = document.getElementById("resultTitle");
const resultYouNameEl = document.getElementById("resultYouName");
const resultYouScoreEl = document.getElementById("resultYouScore");
const resultOppNameEl = document.getElementById("resultOppName");
const resultOppScoreEl = document.getElementById("resultOppScore");
const returnLabelEl = document.getElementById("returnLabel");
const restartBtn = document.getElementById("restartBtn");

const ctx = canvasEl.getContext("2d");
const storageWarnings = new Set();

const state = {
  live: false,
  ended: false,
  round: 0,
  score: 0,
  timeLeftSec: 60,
  roundData: null,
  phase: "waiting", // waiting | observe | input | between | ended
  observeStart: 0,
  observeMs: 0,
  inputProgress: 0,
  roundAdvanceId: null,
  observeDoneId: null,
  rafId: null,
  matchStartAt: 0,
  matchEndAt: 0,
  hardEndId: null,
  snapshotTimerId: null,
  returnHomeId: null,
  returnTickId: null,
  pendingEndPayload: null,
  reported: false,
  startedAtIso: null,
  endedAtIso: null,
  traceStartAt: 0,
  stats: {
    hits: 0,
    misses: 0,
    roundsCompleted: 0,
    reactionTotalMs: 0,
    reactionCount: 0,
    bestTraceMs: null
  },
  comboBrokenPulse: false,
  currentGameMatchId: null,
  seedBase: 0,
  pvp: {
    channel: null,
    supa: null,
    opponentId: null,
    opponentName: "Opponent",
    opponentScore: 0,
    opponentRound: 0,
    opponentProgress: 0,
    opponentProgressRender: 0,
    opponentEnded: false,
    shatterUntil: 0,
    subscribed: false
  }
};

function warnStorage(area, err) {
  if (storageWarnings.has(area)) return;
  storageWarnings.add(area);
  console.warn(`[Storage] ${area} unavailable; fallback active.`, err?.name || err);
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseToken(token) {
  const raw = String(token || "");
  const [id, ...nameParts] = raw.split("|");
  return {
    clientId: id || null,
    name: (nameParts.join("|") || "").trim() || null
  };
}

function ensureClientId() {
  let id = safeGet(sessionStorage, CLIENT_KEY, "session/client-read")
    || safeGet(localStorage, CLIENT_KEY, "local/client-read")
    || "";
  if (id) return id;
  try {
    id = crypto.randomUUID();
  } catch {
    id = `n_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
  safeSet(sessionStorage, CLIENT_KEY, id, "session/client-write");
  safeSet(localStorage, CLIENT_KEY, id, "local/client-write");
  return id;
}

function safeName(raw) {
  return String(raw || "").trim().replace(/\s+/g, " ").slice(0, 16);
}

function hashSeed(text) {
  let h = 2166136261;
  const str = String(text || "");
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const localClientId = ensureClientId();
const localPlayerName = safeName(safeGet(localStorage, NAME_KEY, "local/name-read") || "You") || "You";
const p1 = parseToken(params.get("p1"));
const p2 = parseToken(params.get("p2"));
if (mode === "pvp") {
  const me = p1.clientId === localClientId ? p1 : p2.clientId === localClientId ? p2 : null;
  const opponent = me === p1 ? p2 : me === p2 ? p1 : null;
  if (opponent?.clientId) state.pvp.opponentId = opponent.clientId;
  if (opponent?.name) state.pvp.opponentName = opponent.name;
}

state.currentGameMatchId = matchIdFromUrl || `nexus_${Date.now()}_${Math.random().toString(16).slice(2)}`;
state.seedBase = seedFromUrl || hashSeed(state.currentGameMatchId);

modeLabelEl.textContent = mode === "pvp" ? "Multiplayer" : "Solo";
blindLabelEl.textContent = blindEnabled ? "On" : "Off";
playerNameLabelEl.textContent = localPlayerName;
opponentNameLabelEl.textContent = state.pvp.opponentName;
if (mode !== "pvp") opponentCardEl.style.display = "none";

function updateHud() {
  timerLabelEl.textContent = String(state.timeLeftSec);
  roundLabelEl.textContent = String(state.round);
  playerScoreLabelEl.textContent = String(state.score);
  opponentScoreLabelEl.textContent = String(state.pvp.opponentScore || 0);
}

function resizeCanvas() {
  const rect = canvasEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(360, Math.round(rect.width * dpr));
  const height = Math.max(320, Math.round(rect.height * dpr));
  if (canvasEl.width !== width || canvasEl.height !== height) {
    canvasEl.width = width;
    canvasEl.height = height;
  }
}

function makeRoundData(round) {
  const rng = mulberry32((state.seedBase ^ Math.imul(round, 0x9e3779b1)) >>> 0);
  const w = canvasEl.width;
  const h = canvasEl.height;
  const margin = Math.max(38, Math.min(w, h) * 0.09);
  const anchorCount = clamp(8 + Math.floor(round * 0.45), 8, 16);
  const anchors = [];
  let attempts = 0;

  while (anchors.length < anchorCount && attempts < anchorCount * 35) {
    attempts += 1;
    const x = margin + rng() * Math.max(10, w - margin * 2);
    const y = margin + rng() * Math.max(10, h - margin * 2);
    const tooClose = anchors.some((p) => {
      const dx = p.x - x;
      const dy = p.y - y;
      return dx * dx + dy * dy < 54 * 54;
    });
    if (!tooClose) anchors.push({ x, y });
  }

  while (anchors.length < anchorCount) {
    anchors.push({
      x: margin + rng() * Math.max(10, w - margin * 2),
      y: margin + rng() * Math.max(10, h - margin * 2)
    });
  }

  const pathLength = clamp(5 + Math.floor(round * 0.4), 5, 12);
  const path = [];
  for (let i = 0; i < pathLength; i += 1) {
    path.push(Math.floor(rng() * anchors.length));
  }

  return { anchors, path };
}

function beginObservePhase() {
  if (!state.live) return;
  state.round += 1;
  state.roundData = makeRoundData(state.round);
  state.phase = "observe";
  state.observeStart = performance.now();
  state.observeMs = 900 + state.roundData.path.length * 170;
  state.inputProgress = 0;
  state.comboBrokenPulse = false;
  state.traceStartAt = 0;
  clearTimeout(state.observeDoneId);
  state.observeDoneId = setTimeout(() => {
    if (!state.live) return;
    state.phase = "input";
  }, state.observeMs);
  updateHud();
}

function queueNextRound(delay = 230) {
  clearTimeout(state.roundAdvanceId);
  state.roundAdvanceId = setTimeout(() => {
    if (!state.live) return;
    beginObservePhase();
  }, delay);
}

function getPointCanvas(event) {
  const rect = canvasEl.getBoundingClientRect();
  const dpr = canvasEl.width / Math.max(1, rect.width);
  return {
    x: (event.clientX - rect.left) * dpr,
    y: (event.clientY - rect.top) * dpr
  };
}

function nearestAnchorIndex(point) {
  if (!state.roundData) return -1;
  const anchors = state.roundData.anchors;
  const radius = Math.max(30, Math.min(canvasEl.width, canvasEl.height) * 0.044);
  const radiusSq = radius * radius;
  let best = -1;
  let bestSq = radiusSq;
  for (let i = 0; i < anchors.length; i += 1) {
    const dx = anchors[i].x - point.x;
    const dy = anchors[i].y - point.y;
    const sq = dx * dx + dy * dy;
    if (sq <= bestSq) {
      bestSq = sq;
      best = i;
    }
  }
  return best;
}

function onCanvasTap(event) {
  event.preventDefault();
  if (!state.live || state.phase !== "input" || !state.roundData) return;

  const point = getPointCanvas(event);
  const tapped = nearestAnchorIndex(point);
  if (tapped < 0) return;

  if (state.inputProgress === 0) state.traceStartAt = performance.now();
  const expected = state.roundData.path[state.inputProgress];

  if (tapped === expected) {
    state.inputProgress += 1;
    state.score += 1;
    state.stats.hits += 1;
    if (state.inputProgress >= state.roundData.path.length) {
      state.stats.roundsCompleted += 1;
      const traceMs = Math.max(0, Math.round(performance.now() - state.traceStartAt));
      state.stats.reactionCount += 1;
      state.stats.reactionTotalMs += traceMs;
      if (state.stats.bestTraceMs == null || traceMs < state.stats.bestTraceMs) state.stats.bestTraceMs = traceMs;
      state.phase = "between";
      queueNextRound(200);
    }
  } else {
    state.stats.misses += 1;
    state.comboBrokenPulse = true;
    state.phase = "between";
    queueNextRound(260);
  }

  updateHud();
}

function drawAnchor(point, alpha = 1) {
  const r = 7;
  ctx.beginPath();
  ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(211, 227, 255, ${alpha})`;
  ctx.fill();
}

function drawPathSegment(from, to, color, width = 3, alpha = 1) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color.replace("ALPHA", String(alpha));
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

function drawSpark(now) {
  if (!state.roundData) return;
  const { anchors, path } = state.roundData;
  const safeDuration = Math.max(400, state.observeMs - 160);
  const elapsed = clamp(now - state.observeStart, 0, safeDuration);
  const pathProgress = (elapsed / safeDuration) * (path.length - 1);
  const segMax = Math.floor(pathProgress);
  const frac = pathProgress - segMax;

  for (let i = 0; i < segMax; i += 1) {
    const pA = anchors[path[i]];
    const pB = anchors[path[i + 1]];
    drawPathSegment(pA, pB, "rgba(84, 244, 255, ALPHA)", 4, 0.85);
  }

  if (segMax < path.length - 1) {
    const a = anchors[path[segMax]];
    const b = anchors[path[segMax + 1]];
    const spark = {
      x: a.x + (b.x - a.x) * frac,
      y: a.y + (b.y - a.y) * frac
    };
    drawPathSegment(a, spark, "rgba(84, 244, 255, ALPHA)", 4, 0.9);
    ctx.beginPath();
    ctx.arc(spark.x, spark.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(120, 255, 255, 0.95)";
    ctx.fill();
  }
}

function drawPlayerProgress() {
  if (!state.roundData) return;
  const { anchors, path } = state.roundData;
  const completed = clamp(state.inputProgress, 0, path.length);
  for (let i = 0; i + 1 < completed; i += 1) {
    const from = anchors[path[i]];
    const to = anchors[path[i + 1]];
    drawPathSegment(from, to, "rgba(166, 255, 187, ALPHA)", 3.6, 0.9);
  }
}

function drawGhost() {
  if (!state.roundData || mode !== "pvp") return;
  const { anchors, path } = state.roundData;
  const target = state.pvp.opponentProgress;
  state.pvp.opponentProgressRender += (target - state.pvp.opponentProgressRender) * 0.26;
  const ghostProgress = clamp(state.pvp.opponentProgressRender, 0, path.length);
  const completed = Math.floor(ghostProgress);

  for (let i = 0; i + 1 < completed; i += 1) {
    const from = anchors[path[i]];
    const to = anchors[path[i + 1]];
    drawPathSegment(from, to, "rgba(181, 154, 255, ALPHA)", 3, 0.58);
  }

  if (performance.now() < state.pvp.shatterUntil && completed > 0) {
    const p = anchors[path[Math.min(path.length - 1, completed - 1)]];
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2;
      const distance = 8 + (performance.now() % 22);
      const x = p.x + Math.cos(angle) * distance;
      const y = p.y + Math.sin(angle) * distance;
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(198, 173, 255, 0.9)";
      ctx.fill();
    }
  }
}

function renderFrame(now) {
  const w = canvasEl.width;
  const h = canvasEl.height;
  ctx.clearRect(0, 0, w, h);

  const gridGap = Math.max(56, Math.min(w, h) * 0.12);
  ctx.strokeStyle = "rgba(120, 140, 168, 0.06)";
  ctx.lineWidth = 1;
  for (let x = gridGap * 0.5; x < w; x += gridGap) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = gridGap * 0.5; y < h; y += gridGap) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (state.roundData) {
    const hideAnchors = blindEnabled && state.phase === "input";
    const anchorAlpha = hideAnchors ? 0.06 : state.phase === "observe" ? 0.72 : 0.35;
    for (const anchor of state.roundData.anchors) drawAnchor(anchor, anchorAlpha);
    drawGhost();
    if (state.phase === "observe") drawSpark(now);
    if (state.phase === "input" || state.phase === "between") drawPlayerProgress();
  }

  if (state.live) {
    const leftMs = Math.max(0, state.matchEndAt - Date.now());
    const leftSec = Math.ceil(leftMs / 1000);
    if (leftSec !== state.timeLeftSec) {
      state.timeLeftSec = leftSec;
      updateHud();
    }
  }

  state.rafId = requestAnimationFrame(renderFrame);
}

function showWaiting(title, subtitle) {
  waitingTitleEl.textContent = title;
  waitingSubEl.textContent = subtitle;
  waitingLayerEl.hidden = false;
}

function hideWaiting() {
  waitingLayerEl.hidden = true;
}

function showCountdown(startAt) {
  showWaiting("Get Ready", "Starting in 3...");
  const tick = () => {
    const left = Math.max(0, Math.ceil((startAt - Date.now()) / 1000));
    waitingSubEl.textContent = left > 0 ? `Starting in ${left}...` : "Go!";
    timerLabelEl.textContent = left > 0 ? String(left) : "60";
    if (Date.now() < startAt) {
      requestAnimationFrame(tick);
    }
  };
  tick();
}

function stashPending(payload) {
  state.pendingEndPayload = payload;
  safeSet(localStorage, PENDING_END_KEY, JSON.stringify(payload), "local/pending-write");
}

function clearPending() {
  state.pendingEndPayload = null;
  safeRemove(localStorage, PENDING_END_KEY, "local/pending-remove");
}

async function flushPending() {
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
    clearPending();
  } catch {
    /* ignore */
  }
}

async function reportEnd() {
  if (state.reported || !state.pendingEndPayload) return;
  state.reported = true;
  try {
    const res = await fetch("/api/match/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.pendingEndPayload)
    });
    if (!res.ok) throw new Error("bad status");
    clearPending();
  } catch {
    state.reported = false;
  }
}

function winnerKey() {
  if (mode !== "pvp") return "you";
  if (state.score === state.pvp.opponentScore) return "draw";
  return state.score > state.pvp.opponentScore ? "you" : "opponent";
}

function buildEndPayload(reason = "time") {
  const avgReactionMs = state.stats.reactionCount > 0
    ? Math.round(state.stats.reactionTotalMs / state.stats.reactionCount)
    : 0;

  return {
    matchId: state.currentGameMatchId,
    playerName: localPlayerName,
    opponentName: mode === "pvp" ? (state.pvp.opponentName || "Opponent") : null,
    mode: "nexus",
    difficulty: "nexus",
    duration: 60,
    startedAt: state.startedAtIso,
    endedAt: state.endedAtIso,
    playerScore: state.score,
    botScore: mode === "pvp" ? state.pvp.opponentScore : null,
    winner: reason === "left" ? "you" : winnerKey(),
    patternsPlayed: state.round,
    stats: {
      nexus: {
        rounds: state.round,
        hits: state.stats.hits,
        misses: state.stats.misses,
        avgTraceMs: avgReactionMs,
        bestTraceMs: state.stats.bestTraceMs,
        blindEnabled,
        modeType: mode
      }
    }
  };
}

function startReturnCountdown(seconds = RETURN_HOME_SECONDS) {
  clearTimeout(state.returnHomeId);
  clearInterval(state.returnTickId);
  let left = Math.max(1, seconds);
  returnLabelEl.textContent = `Going back to home in ${left} seconds...`;
  state.returnTickId = setInterval(() => {
    left -= 1;
    returnLabelEl.textContent = `Going back to home in ${Math.max(0, left)} seconds...`;
    if (left <= 0) {
      clearInterval(state.returnTickId);
      state.returnTickId = null;
    }
  }, 1000);
  state.returnHomeId = setTimeout(() => {
    window.location.href = "index.html";
  }, seconds * 1000);
}

function publishFinal() {
  if (mode !== "pvp" || !state.pvp.channel) return;
  state.pvp.channel.send({
    type: "broadcast",
    event: "state_snapshot",
    payload: {
      matchId: state.currentGameMatchId,
      playerId: localClientId,
      playerName: localPlayerName,
      score: state.score,
      round: state.round,
      progressIndex: state.inputProgress,
      comboBroken: false,
      ended: true,
      t: Date.now()
    }
  });
}

function endMatch(reason = "time") {
  if (state.ended) return;
  state.ended = true;
  state.live = false;
  state.phase = "ended";
  state.endedAtIso = new Date().toISOString();
  clearTimeout(state.hardEndId);
  clearTimeout(state.roundAdvanceId);
  clearTimeout(state.observeDoneId);
  clearInterval(state.snapshotTimerId);
  state.snapshotTimerId = null;

  publishFinal();

  const oppName = mode === "pvp" ? (state.pvp.opponentName || "Opponent") : "—";
  const title = reason === "left"
    ? `${localPlayerName} Wins`
    : mode === "pvp"
      ? state.score === state.pvp.opponentScore
        ? "Draw"
        : state.score > state.pvp.opponentScore
          ? `${localPlayerName} Wins`
          : `${oppName} Wins`
      : `${localPlayerName} Wins`;

  resultTitleEl.textContent = title;
  resultYouNameEl.textContent = localPlayerName;
  resultYouScoreEl.textContent = String(state.score);
  resultOppNameEl.textContent = mode === "pvp" ? oppName : "—";
  resultOppScoreEl.textContent = mode === "pvp" ? String(state.pvp.opponentScore) : "—";
  resultLayerEl.hidden = false;
  hideWaiting();
  startReturnCountdown(RETURN_HOME_SECONDS);

  stashPending(buildEndPayload(reason));
  reportEnd();
}

function startRealtimeSnapshots() {
  if (mode !== "pvp" || !state.pvp.channel) return;
  clearInterval(state.snapshotTimerId);
  state.snapshotTimerId = setInterval(() => {
    if (!state.live || !state.pvp.channel) return;
    const payload = {
      matchId: state.currentGameMatchId,
      playerId: localClientId,
      playerName: localPlayerName,
      score: state.score,
      round: state.round,
      progressIndex: state.inputProgress,
      comboBroken: state.comboBrokenPulse,
      ended: false,
      t: Date.now()
    };
    state.comboBrokenPulse = false;
    state.pvp.channel.send({ type: "broadcast", event: "state_snapshot", payload });
  }, SNAPSHOT_MS);
}

function startMatch(startAtMs) {
  state.startedAtIso = new Date(startAtMs).toISOString();
  state.matchStartAt = startAtMs;
  state.matchEndAt = startAtMs + MATCH_MS;
  state.timeLeftSec = 60;
  updateHud();
  showCountdown(startAtMs);

  const delay = Math.max(0, startAtMs - Date.now());
  setTimeout(() => {
    hideWaiting();
    state.live = true;
    state.phase = "observe";
    state.ended = false;
    state.hardEndId = setTimeout(() => endMatch("time"), MATCH_MS + 10);
    beginObservePhase();
    startRealtimeSnapshots();
  }, delay);
}

async function setupPvp() {
  if (typeof createClient !== "function") {
    showWaiting("Realtime unavailable", "Supabase SDK not loaded.");
    return;
  }

  state.pvp.supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  const topic = `nexus:match:${state.currentGameMatchId}`;
  const channel = state.pvp.supa.channel(topic, {
    config: {
      broadcast: { self: true, ack: false },
      presence: { key: localClientId }
    }
  });

  channel
    .on("broadcast", { event: "match_start" }, ({ payload }) => {
      if (!payload || payload.matchId !== state.currentGameMatchId) return;
      if (!state.matchStartAt) {
        state.seedBase = Number(payload.seed || state.seedBase) || state.seedBase;
        state.matchStartAt = Number(payload.startAt || 0) || (Date.now() + 3000);
        startMatch(state.matchStartAt);
      }
    })
    .on("broadcast", { event: "state_snapshot" }, ({ payload }) => {
      if (!payload || payload.matchId !== state.currentGameMatchId) return;
      if (payload.playerId === localClientId) return;
      const nextScore = Number(payload.score);
      const nextRound = Number(payload.round);
      const nextProgress = Number(payload.progressIndex);
      if (Number.isFinite(nextScore)) state.pvp.opponentScore = Math.max(0, nextScore);
      if (Number.isFinite(nextRound)) state.pvp.opponentRound = Math.max(0, nextRound);
      if (Number.isFinite(nextProgress)) state.pvp.opponentProgress = Math.max(0, nextProgress);
      if (payload.playerName) {
        state.pvp.opponentName = String(payload.playerName);
        opponentNameLabelEl.textContent = state.pvp.opponentName;
      }
      if (payload.comboBroken) state.pvp.shatterUntil = performance.now() + 620;
      if (payload.ended) state.pvp.opponentEnded = true;
      updateHud();
    })
    .on("presence", { event: "sync" }, () => {
      const pres = channel.presenceState();
      const ids = Object.keys(pres || {}).sort();
      const hasOpponent = ids.some((id) => id !== localClientId);
      if (!hasOpponent && state.live) {
        endMatch("left");
        return;
      }
      if (!hasOpponent && !state.live && !state.matchStartAt) {
        showWaiting("Waiting for opponent", "Share your private code or wait for a match...");
        return;
      }

      if (state.matchStartAt) return;
      const leaderId = ids[0];
      if (leaderId === localClientId) {
        const startAt = Date.now() + 3000;
        channel.send({
          type: "broadcast",
          event: "match_start",
          payload: {
            matchId: state.currentGameMatchId,
            seed: state.seedBase,
            startAt
          }
        });
        state.matchStartAt = startAt;
        startMatch(startAt);
      } else {
        showWaiting("Match Found", "Syncing start...");
      }
    })
    .on("presence", { event: "leave" }, ({ leftPresences }) => {
      if (!state.live) return;
      const left = Array.isArray(leftPresences) ? leftPresences : [];
      if (left.some((m) => m?.clientId && m.clientId !== localClientId)) endMatch("left");
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        state.pvp.subscribed = true;
        await channel.track({
          clientId: localClientId,
          playerName: localPlayerName,
          onlineAt: new Date().toISOString()
        });
        return;
      }
      if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
        showWaiting("Connection error", "Realtime channel failed. Returning home...");
        setTimeout(() => {
          window.location.href = "index.html";
        }, 2400);
      }
    });

  state.pvp.channel = channel;
  showWaiting("Preparing Match", "Syncing players…");

  if (startAtFromUrl > Date.now()) {
    state.matchStartAt = startAtFromUrl;
    startMatch(startAtFromUrl);
  }
}

function startSolo() {
  const startAt = Date.now() + 650;
  showWaiting("Get Ready", "Starting...");
  startMatch(startAt);
}

function resetStateForRestart() {
  clearTimeout(state.roundAdvanceId);
  clearTimeout(state.observeDoneId);
  clearTimeout(state.hardEndId);
  clearInterval(state.snapshotTimerId);
  clearTimeout(state.returnHomeId);
  clearInterval(state.returnTickId);
  state.returnTickId = null;

  state.live = false;
  state.ended = false;
  state.phase = "waiting";
  state.round = 0;
  state.score = 0;
  state.timeLeftSec = 60;
  state.roundData = null;
  state.inputProgress = 0;
  state.reported = false;
  state.startedAtIso = null;
  state.endedAtIso = null;
  state.stats.hits = 0;
  state.stats.misses = 0;
  state.stats.roundsCompleted = 0;
  state.stats.reactionTotalMs = 0;
  state.stats.reactionCount = 0;
  state.stats.bestTraceMs = null;
  state.comboBrokenPulse = false;
  state.pvp.opponentScore = 0;
  state.pvp.opponentProgress = 0;
  state.pvp.opponentProgressRender = 0;
  state.pvp.shatterUntil = 0;
  resultLayerEl.hidden = true;
  updateHud();
}

function restartSession() {
  if (mode === "pvp") {
    window.location.href = "index.html";
    return;
  }
  resetStateForRestart();
  startSolo();
}

function beaconPending() {
  if (state.reported || !state.pendingEndPayload) return;
  try {
    const blob = new Blob([JSON.stringify(state.pendingEndPayload)], { type: "application/json" });
    navigator.sendBeacon?.("/api/match/end", blob);
  } catch {
    /* ignore */
  }
}

canvasEl.addEventListener("pointerdown", onCanvasTap, { passive: false });
restartBtn.addEventListener("click", restartSession);
window.addEventListener("resize", resizeCanvas);
window.addEventListener("beforeunload", beaconPending);
document.addEventListener("pagehide", () => {
  beaconPending();
  try {
    state.pvp.channel?.send({ type: "broadcast", event: "leave", payload: { playerId: localClientId } });
  } catch {
    /* ignore */
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") beaconPending();
});

flushPending();
resizeCanvas();
updateHud();
state.rafId = requestAnimationFrame(renderFrame);

if (mode === "pvp") {
  setupPvp();
} else {
  startSolo();
}
