"use strict";

/**
 * MindSnap bot worker (runs off the UI thread).
 *
 * Messages IN (main -> worker):
 *   { type: "start", epoch: number, pattern: { targets: number[], clickLimit: number, profile: { accuracy, delayMin, delayMax } } }
 *   { type: "stop" }
 *
 * Messages OUT (worker -> main):
 *   { type: "click", epoch: number, hit: boolean }
 *   { type: "done",  epoch: number }
 */

let activeEpoch = -1;
let clicksUsed = 0;
let clickLimit = 0;
let profile = null;
let timerId = null;
let plannedHits = 0;
let hitsMade = 0;
let remaining = [];

function stop() {
  clearTimeout(timerId);
  timerId = null;
  activeEpoch = -1;
}

function scheduleNext() {
  if (activeEpoch === -1 || clicksUsed >= clickLimit) {
    self.postMessage({ type: "done", epoch: activeEpoch });
    return;
  }

  const delay = Math.round(
    profile.delayMin + Math.random() * (profile.delayMax - profile.delayMin)
  );
  timerId = setTimeout(performClick, delay);
}

function performClick() {
  if (activeEpoch === -1 || clicksUsed >= clickLimit) {
    self.postMessage({ type: "done", epoch: activeEpoch });
    return;
  }

  const remainingClicks = Math.max(1, clickLimit - clicksUsed);
  const remainingHits = Math.max(0, plannedHits - hitsMade);
  const shouldHit = remainingHits > 0 && Math.random() < remainingHits / remainingClicks;
  let hit = false;

  if (shouldHit && remaining.length > 0) {
    const pickIdx = Math.floor(Math.random() * remaining.length);
    remaining[pickIdx] = remaining[remaining.length - 1];
    remaining.pop();
    hit = true;
    hitsMade += 1;
  }

  clicksUsed += 1;
  self.postMessage({ type: "click", epoch: activeEpoch, hit });
  scheduleNext();
}

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === "stop") {
    stop();
    return;
  }

  if (msg.type === "start") {
    clearTimeout(timerId);

    activeEpoch = msg.epoch;
    const inputTargets = Array.isArray(msg.pattern?.targets) ? msg.pattern.targets : [];
    clickLimit = Number(msg.pattern?.clickLimit || 0);
    profile = msg.pattern?.profile || { accuracy: 0.7, delayMin: 400, delayMax: 700 };
    clicksUsed = 0;
    hitsMade = 0;
    remaining = inputTargets.slice();
    plannedHits = Math.max(
      0,
      Math.min(
        clickLimit,
        Math.round(clickLimit * Number(profile.accuracy || 0)) + (Math.random() < 0.5 ? 0 : 1)
      )
    );

    scheduleNext();
  }
};
