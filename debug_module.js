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
  const prefix = `[${timestamp}] 🎮 ${category}`;
  if (typeof data !== "undefined") console.log(`${prefix}: ${message}`, data);
  else console.log(`${prefix}: ${message}`);
}

function debugError(category, error, context) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`❌ [${category}] ${err.message}`, context || err);
}

function verifySupabaseLoaded() {
  if (typeof supabase === "undefined") {
    console.error("❌ Supabase library not loaded! Check CDN link in HTML.");
    return false;
  }
  debugLog("INIT", "✅ Supabase library loaded");
  return true;
}

function runStartupDiagnostics() {
  if (!DEBUG_MODE) return;

  console.log("🎮 MindSnap Startup Diagnostics");
  console.log("================================");

  const supabaseOk = verifySupabaseLoaded();
  console.log(supabaseOk ? "✅ Supabase" : "❌ Supabase");

  try {
    const modeLabel = typeof mode === "string" ? mode : "(unknown)";
    console.log(`✅ Mode: ${modeLabel}`);
    if (modeLabel === "pvp") {
      console.log(`✅ PvP matchId: ${state?.pvp?.matchId}`);
      console.log(`✅ PvP seed: ${state?.pvp?.seed}`);
      console.log(`✅ Local clientId: ${typeof localClientId !== "undefined" ? localClientId : "(missing)"}`);
      console.log(`✅ Local name: ${typeof localPlayerName !== "undefined" ? localPlayerName : "(missing)"}`);
      console.log(`✅ OpponentId: ${state?.pvp?.opponentId}`);
      console.log(`✅ OpponentName: ${state?.pvp?.opponentName}`);
    }
  } catch {
    console.log("❌ Mode: (missing)");
  }

  try {
    console.log(`✅ Board element: ${typeof boardEl !== "undefined" && boardEl ? "found" : "missing"}`);
    console.log(`✅ Timer element: ${typeof timerEl !== "undefined" && timerEl ? "found" : "missing"}`);
    console.log(`✅ Overlay element: ${typeof overlayEl !== "undefined" && overlayEl ? "found" : "missing"}`);
  } catch {
    /* ignore */
  }

  console.log("================================");
}

function installPvPDebugHooks() {
  try {
    if (typeof mode !== "string" || mode !== "pvp") return;

    if (typeof initPvPRealtime === "function") {
      const originalInit = initPvPRealtime;
      initPvPRealtime = function initPvPRealtime_debug() {
        debugLog("PVP", "initPvPRealtime()", {
          enabled: state?.pvp?.enabled,
          matchId: state?.pvp?.matchId,
          opponentId: state?.pvp?.opponentId,
          hasSupabase: typeof supabase !== "undefined"
        });
        return originalInit.apply(this, arguments);
      };
    }

    if (typeof sendPvPScore === "function") {
      const originalScore = sendPvPScore;
      sendPvPScore = function sendPvPScore_debug() {
        debugLog("PVP-SEND", "score", { score: state?.player?.totalScore, timeLeft: state?.timeLeft });
        return originalScore.apply(this, arguments);
      };
    }

    if (typeof sendPvPFinal === "function") {
      const originalFinal = sendPvPFinal;
      sendPvPFinal = function sendPvPFinal_debug() {
        debugLog("PVP-SEND", "final", { score: state?.player?.totalScore });
        return originalFinal.apply(this, arguments);
      };
    }

    // Tap into Supabase channel lifecycle if present.
    const ch = state?.pvp?.channel;
    if (ch && typeof ch.subscribe === "function") {
      debugLog("PVP", "Channel exists", { topic: ch.topic || "(unknown)" });
    } else {
      debugLog("PVP", "Channel not ready yet (will rely on internal logs)");
    }

    debugLog("INIT", "✅ PvP debug hooks installed");
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
