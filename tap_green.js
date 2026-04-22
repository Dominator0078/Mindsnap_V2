const tapZoneEl = document.getElementById("tapZone");
const zoneLabelEl = document.getElementById("zoneLabel");
const feedbackEl = document.getElementById("feedback");
const scoreValueEl = document.getElementById("scoreValue");
const stateValueEl = document.getElementById("stateValue");
const trialsValueEl = document.getElementById("trialsValue");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resultOverlayEl = document.getElementById("resultOverlay");
const resultTitleEl = document.getElementById("resultTitle");
const resultScoreEl = document.getElementById("resultScore");
const resultDetailsEl = document.getElementById("resultDetails");
const closeResultBtn = document.getElementById("closeResultBtn");

const NAME_KEY = "mindsnap_name_v1";
const storageWarnings = new Set();
const state = {
  running: false,
  phase: "idle", // idle | waiting | green
  waitTimerId: null,
  greenShownAt: 0,
  trialResolved: false,
  startedAt: 0,
  score: 0,
  hits: 0,
  earlyTaps: 0,
  trials: 0,
  reactions: [],
  reported: false
};

function safeGet(storage, key, area) {
  try {
    return storage.getItem(key);
  } catch (err) {
    if (!storageWarnings.has(area)) {
      storageWarnings.add(area);
      console.warn(`[Storage] ${area} unavailable; using fallback.`, err?.name || err);
    }
    return null;
  }
}

function setPhase(phase) {
  state.phase = phase;
  tapZoneEl.classList.remove("idle", "waiting", "red", "green");
  if (phase === "idle") {
    tapZoneEl.classList.add("idle");
    stateValueEl.textContent = "IDLE";
    zoneLabelEl.textContent = "Press Start";
    return;
  }
  if (phase === "waiting") {
    tapZoneEl.classList.add("waiting", "red");
    stateValueEl.textContent = "RED";
    zoneLabelEl.textContent = "Wait...";
    return;
  }
  tapZoneEl.classList.add("green");
  stateValueEl.textContent = "GREEN";
  zoneLabelEl.textContent = "Tap!";
}

function randomWaitMs() {
  return 1000 + Math.random() * 3000;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function updateHud() {
  scoreValueEl.textContent = String(state.score);
  trialsValueEl.textContent = String(state.trials);
}

function resetSession() {
  state.score = 0;
  state.hits = 0;
  state.earlyTaps = 0;
  state.trials = 0;
  state.reactions = [];
  state.reported = false;
  state.greenShownAt = 0;
  state.trialResolved = false;
  state.startedAt = Date.now();
  updateHud();
}

function clearLoopTimer() {
  clearTimeout(state.waitTimerId);
  state.waitTimerId = null;
}

function setFeedback(text) {
  feedbackEl.textContent = text;
}

function beginNextTrial() {
  if (!state.running) return;
  clearLoopTimer();
  state.trialResolved = false;
  setPhase("waiting");
  setFeedback("Red phase. Wait for green.");

  const waitMs = randomWaitMs();
  state.waitTimerId = setTimeout(() => {
    if (!state.running) return;
    state.trialResolved = false;
    state.greenShownAt = performance.now();
    setPhase("green");
    setFeedback("Green! Tap now.");
  }, waitMs);
}

async function reportReactionEnd() {
  if (state.reported) return;
  state.reported = true;

  const avgReactionMs = Math.round(mean(state.reactions));
  const bestReactionMs = state.reactions.length ? Math.round(Math.min(...state.reactions)) : null;
  const elapsedSec = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
  const playerName = (safeGet(localStorage, NAME_KEY, "local/playerName-read") || "You").trim() || "You";
  const payload = {
    mode: "reaction",
    difficulty: "reaction",
    duration: elapsedSec,
    playerName,
    opponentName: null,
    startedAt: new Date(state.startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    playerScore: state.score,
    botScore: null,
    winner: "you",
    patternsPlayed: state.trials,
    stats: {
      reaction: {
        hits: state.hits,
        earlyTaps: state.earlyTaps,
        avgReactionMs,
        bestReactionMs
      }
    }
  };

  try {
    await fetch("/api/match/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    // No-op: game remains playable even if report fails.
  }
}

function showResult() {
  const avg = Math.round(mean(state.reactions));
  const best = state.reactions.length ? Math.round(Math.min(...state.reactions)) : null;
  resultTitleEl.textContent = "Session Complete";
  resultScoreEl.textContent = `Score: ${state.score}`;
  resultDetailsEl.textContent = `Hits: ${state.hits} | Early taps: ${state.earlyTaps} | Avg: ${avg} ms | Best: ${best == null ? "-" : `${best} ms`}`;
  resultOverlayEl.hidden = false;
}

function stopSession() {
  if (!state.running) return;
  state.running = false;
  clearLoopTimer();
  setPhase("idle");
  startBtn.disabled = false;
  stopBtn.disabled = true;
  reportReactionEnd();
  showResult();
}

function startSession() {
  if (state.running) return;
  resultOverlayEl.hidden = true;
  state.running = true;
  resetSession();
  startBtn.disabled = true;
  stopBtn.disabled = false;
  setFeedback("Session started. Tap only on green.");
  beginNextTrial();
}

function handleTap(event) {
  event.preventDefault();
  if (!state.running) return;

  if (state.phase === "green") {
    if (state.trialResolved) return;
    state.trialResolved = true;
    const reactionMs = Math.max(0, performance.now() - state.greenShownAt);
    state.reactions.push(reactionMs);
    state.hits += 1;
    state.trials += 1;
    state.score += 1;
    setFeedback(`Reaction: ${Math.round(reactionMs)} ms`);
    updateHud();
    beginNextTrial();
    return;
  }

  if (state.phase === "waiting") {
    state.earlyTaps += 1;
    state.score -= 1;
    setFeedback("Early Tap");
    updateHud();
  }
}

tapZoneEl.addEventListener("pointerdown", handleTap, { passive: false });
startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
closeResultBtn.addEventListener("click", () => {
  resultOverlayEl.hidden = true;
});

window.addEventListener("pagehide", () => {
  clearLoopTimer();
  if (state.running) {
    state.running = false;
    reportReactionEnd();
  }
});

setPhase("idle");
updateHud();
