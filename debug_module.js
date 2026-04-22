"use strict";

/**
 * MindSnap Debug Module (optional)
 *
 * Loaded after `script.js` on the Game Zone to provide:
 * - Startup diagnostics
 * - PvP matchmaking/runtime logging
 *
 * Safe to keep in production: set DEBUG_MODE=false to silence logs.
 */

const DEBUG_MODE = true;

function debugLog(category, message, data) {
  if (!DEBUG_MODE) return;
  const timestamp = new Date().toLocaleTimeString();
  const prefix = `[${timestamp}] ðŸŽ® ${category}`;
  if (typeof data !== "undefined") console.log(`${prefix}: ${message}`, data);
  else console.log(`${prefix}: ${message}`);
}

function debugError(category, error, context) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`âŒ [${category}] ${err.message}`, context || err);
}

function verifySupabaseLoaded() {
  // `script.js` runs as a module, so Supabase isn't a global. Use `window.__mindsnap` to verify load.
  const ctx = window.__mindsnap;
  if (!ctx) {
    console.error("❌ Game runtime not loaded (window.__mindsnap missing). Check script.js module load.");
    return false;
  }
  debugLog("INIT", "✅ Game runtime loaded");
  return true;
}

function runStartupDiagnostics() {
  if (!DEBUG_MODE) return;

  console.log("ðŸŽ® MindSnap Startup Diagnostics");
  console.log("================================");

  const runtimeOk = verifySupabaseLoaded();
  console.log(runtimeOk ? "✅ Runtime" : "❌ Runtime");

  try {
    const ctx = window.__mindsnap;
    const modeLabel = ctx?.mode || "(unknown)";
    console.log(`âœ… Mode: ${modeLabel}`);
    if (modeLabel === "pvp") {
      console.log(`âœ… PvP matchId: ${ctx?.state?.pvp?.matchId}`);
      console.log(`âœ… PvP seed: ${ctx?.state?.pvp?.seed}`);
      console.log(`âœ… Local clientId: ${ctx?.localClientId || "(missing)"}`);
      console.log(`âœ… Local name: ${ctx?.localPlayerName || "(missing)"}`);
      console.log(`âœ… OpponentId: ${ctx?.state?.pvp?.opponentId}`);
      console.log(`âœ… OpponentName: ${ctx?.state?.pvp?.opponentName}`);
    }
  } catch {
    console.log("âŒ Mode: (missing)");
  }

  try {
    const hasBoard = !!document.getElementById("board");
    const hasTimer = !!document.getElementById("timer");
    const hasOverlay = !!document.getElementById("overlay");
    console.log(`âœ… Board element: ${hasBoard ? "found" : "missing"}`);
    console.log(`âœ… Timer element: ${hasTimer ? "found" : "missing"}`);
    console.log(`âœ… Overlay element: ${hasOverlay ? "found" : "missing"}`);
  } catch {
    /* ignore */
  }

  console.log("================================");
}

function installPvPDebugHooks() {
  try {
    const ctx = window.__mindsnap;
    if (!ctx || ctx.mode !== "pvp") return;

    // Tap into Supabase channel lifecycle if present.
    const ch = ctx?.state?.pvp?.channel;
    if (ch && typeof ch.subscribe === "function") {
      debugLog("PVP", "Channel exists", { topic: ch.topic || "(unknown)" });
    } else {
      debugLog("PVP", "Channel not ready yet (will rely on internal logs)");
    }

    debugLog("INIT", "âœ… PvP debug hooks installed");
  } catch (err) {
    debugError("INIT", err, { context: "installPvPDebugHooks failed" });
  }
}

document.addEventListener(
  "DOMContentLoaded",
  () => {
    setTimeout(runStartupDiagnostics, 100);
    setTimeout(installPvPDebugHooks, 300);
  },
  false
);

debugLog("INIT", "Debug module loaded");

