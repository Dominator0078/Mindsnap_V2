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
    const ctx = window.__mindsnap;
    const modeLabel = ctx?.mode || "(unknown)";
    console.log(`✅ Mode: ${modeLabel}`);
    if (modeLabel === "pvp") {
      console.log(`✅ PvP matchId: ${ctx?.state?.pvp?.matchId}`);
      console.log(`✅ PvP seed: ${ctx?.state?.pvp?.seed}`);
      console.log(`✅ Local clientId: ${ctx?.localClientId || "(missing)"}`);
      console.log(`✅ Local name: ${ctx?.localPlayerName || "(missing)"}`);
      console.log(`✅ OpponentId: ${ctx?.state?.pvp?.opponentId}`);
      console.log(`✅ OpponentName: ${ctx?.state?.pvp?.opponentName}`);
    }
  } catch {
    console.log("❌ Mode: (missing)");
  }

  try {
    const hasBoard = !!document.getElementById("board");
    const hasTimer = !!document.getElementById("timer");
    const hasOverlay = !!document.getElementById("overlay");
    console.log(`✅ Board element: ${hasBoard ? "found" : "missing"}`);
    console.log(`✅ Timer element: ${hasTimer ? "found" : "missing"}`);
    console.log(`✅ Overlay element: ${hasOverlay ? "found" : "missing"}`);
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
