#!/usr/bin/env node
/**
 * Solid on-device gesture + state harness for the chat overlay (Android
 * emulator/device via adb + Chrome DevTools Protocol).
 *
 * WHY THIS EXISTS: `adb shell input swipe/motionevent` and `idb ui swipe` were
 * "flaky" for the chat drag gestures — but the real cause was NOT the input API.
 * The app's WebView sits BELOW the status bar, so a CSS point (from
 * getBoundingClientRect) maps to a device pixel with a top OFFSET:
 *     deviceY = cssY * devicePixelRatio + statusBarOffsetPx
 * Every hand-computed `deviceY = cssY * dpr` landed ~offset px ABOVE its target,
 * so the swipe started off the thin (21px) grabber strip and delivered its
 * pointer stream to the background instead of the gesture. Taps "sometimes
 * worked" only because their larger tolerance occasionally still hit.
 *
 * The fix is a one-tap CALIBRATION: tap a known device point, read where it
 * landed in CSS via CDP, and solve for (scale, offsetX, offsetY). After that,
 * ordinary `adb input swipe` with corrected coordinates drives maximize /
 * restore / open / collapse deterministically — verified against data-maximized.
 *
 * Usage:
 *   node chat-device-gesture.mjs read
 *   node chat-device-gesture.mjs maximize
 *   node chat-device-gesture.mjs restore
 *   node chat-device-gesture.mjs open-half
 *   node chat-device-gesture.mjs collapse
 *   node chat-device-gesture.mjs tap-composer
 * Env: ELIZA_ADB_SERIAL (default: first booted device), ELIZA_APP_PKG
 *   (default ai.elizaos.app), ELIZA_CDP_PORT (default 9333).
 *
 * iOS parity note: the SAME offset applies to idb swipes on iOS (the notch/
 * status-bar band), so the identical calibrate-then-convert flow fixes idb —
 * the only extra piece is reading state through the WebKit inspector protocol
 * (ios_webkit_debug_proxy) instead of CDP. This harness implements the Android
 * (CDP) half; the coordinate math is platform-agnostic.
 */

import { execFileSync } from "node:child_process";

const SERIAL = process.env.ELIZA_ADB_SERIAL || firstBootedDevice();
const PKG = process.env.ELIZA_APP_PKG || "ai.elizaos.app";
const PORT = Number(process.env.ELIZA_CDP_PORT || 9333);

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}
function adb(...args) {
  return sh("adb", ["-s", SERIAL, ...args]);
}
function firstBootedDevice() {
  const out = sh("adb", ["devices"]);
  const line = out.split("\n").find((l) => /\tdevice$/.test(l));
  if (!line) throw new Error("no booted adb device");
  return line.split("\t")[0];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP: one persistent websocket, request/response by id ────────────────────
async function connectCdp() {
  const pid = adb("shell", "pidof", PKG).trim();
  if (!pid) throw new Error(`${PKG} not running`);
  const sock = adb("shell", "cat", "/proc/net/unix")
    .split("\n")
    .map((l) => (l.match(/webview_devtools_remote_\d+/) || [])[0])
    .find(Boolean);
  if (!sock) throw new Error("no webview_devtools_remote socket");
  try {
    adb("forward", "--remove", `tcp:${PORT}`);
  } catch {}
  adb("forward", `tcp:${PORT}`, `localabstract:${sock}`);
  const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, (m) => {
        if (m.result?.result && "value" in m.result.result)
          resolve(m.result.result.value);
        else reject(new Error(JSON.stringify(m.result || m.error)));
      });
      ws.send(
        JSON.stringify({
          id: mid,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  return { evaluate, close: () => ws.close() };
}

// ── Calibration: solve device→CSS offset from one tap ────────────────────────
async function calibrate(cdp) {
  const dpr = await cdp.evaluate("window.devicePixelRatio || 1");
  await cdp.evaluate(
    "(()=>{window.__cal=null;document.addEventListener('pointerdown',e=>{if(window.__cal==null)window.__cal={x:e.clientX,y:e.clientY};},{capture:true});return 1;})()",
  );
  // Tap a stable mid-screen point; read where it landed in CSS.
  const size = adb("shell", "wm", "size").match(/(\d+)x(\d+)/);
  const dx = Math.round(Number(size[1]) / 2);
  const dy = Math.round(Number(size[2]) / 2);
  adb("shell", "input", "tap", String(dx), String(dy));
  await sleep(500);
  const landed = JSON.parse(await cdp.evaluate("JSON.stringify(window.__cal)"));
  if (!landed) throw new Error("calibration tap not observed");
  return {
    dpr,
    offsetX: dx - landed.x * dpr,
    offsetY: dy - landed.y * dpr,
  };
}
const toDevice = (cal, cssX, cssY) => ({
  x: Math.round(cssX * cal.dpr + cal.offsetX),
  y: Math.round(cssY * cal.dpr + cal.offsetY),
});

async function cssCenter(cdp, testid) {
  const v = await cdp.evaluate(
    `(()=>{const e=document.querySelector('[data-testid=${JSON.stringify(testid)}]');if(!e)return 'null';const r=e.getBoundingClientRect();return JSON.stringify({cx:r.x+r.width/2,cy:r.y+r.height/2});})()`,
  );
  return v === "null" ? null : JSON.parse(v);
}
async function readState(cdp) {
  return JSON.parse(
    await cdp.evaluate(
      `(()=>{const s=document.querySelector('[data-testid="chat-sheet"]');return JSON.stringify({detent:s?.getAttribute('data-detent'),maximized:s?.getAttribute('data-maximized'),chatState:s?.getAttribute('data-chat-state')});})()`,
    ),
  );
}

// ── Gesture primitives (corrected coords) ────────────────────────────────────
async function swipeCss(cal, fromX, fromY, toX, toY, ms = 300) {
  const a = toDevice(cal, fromX, fromY);
  const b = toDevice(cal, toX, toY);
  adb(
    "shell",
    "input",
    "swipe",
    String(a.x),
    String(a.y),
    String(b.x),
    String(b.y),
    String(ms),
  );
}
async function tapCss(cal, x, y) {
  const d = toDevice(cal, x, y);
  adb("shell", "input", "tap", String(d.x), String(d.y));
}

// ── Actions ──────────────────────────────────────────────────────────────────
async function run(action) {
  const cdp = await connectCdp();
  const cal = await calibrate(cdp);
  const before = await readState(cdp);
  const grab = () => cssCenter(cdp, "chat-sheet-grabber");
  switch (action) {
    case "read":
      break;
    case "open-half": {
      const g = await grab();
      if (g) await swipeCss(cal, g.cx, g.cy, g.cx, g.cy - 200, 300);
      break;
    }
    case "maximize": {
      // pull the grabber to the very top (crosses the maximize threshold)
      let g = await grab();
      if (g) await swipeCss(cal, g.cx, g.cy, g.cx, 6, 280);
      await sleep(400);
      if ((await readState(cdp)).maximized !== "true") {
        g = await grab();
        if (g) await swipeCss(cal, g.cx, g.cy, g.cx, 6, 300);
      }
      break;
    }
    case "restore": {
      const z = await cssCenter(cdp, "chat-maximize-restore-zone");
      if (z) await swipeCss(cal, z.cx, z.cy, z.cx, z.cy + 600, 300);
      break;
    }
    case "collapse": {
      const g = await grab();
      if (g) await tapCss(cal, g.cx, g.cy);
      break;
    }
    case "tap-composer": {
      const c = await cssCenter(cdp, "chat-composer-textarea");
      if (c) await tapCss(cal, c.cx, c.cy);
      break;
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
  await sleep(action === "read" ? 0 : 900);
  const after = await readState(cdp);
  console.log(
    JSON.stringify({ action, calibration: cal, before, after }, null, 2),
  );
  cdp.close();
}

run(process.argv[2] || "read").catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
