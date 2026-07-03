#!/usr/bin/env bun
/**
 * #11373 — Android emulator AEC acoustic-loop driver.
 *
 * Drives the committed on-device harness (`window.__aecLoop`, installed by
 * packages/ui installAecLoopHarness on Android) inside the app's WebView over
 * CDP, runs the echo-only and double-talk passes, and pulls the result JSONs
 * (agent-side aec-capture + page PCM + delivery counters) back to the host.
 *
 * Host acoustics note: the emulator routes the guest speaker to the HOST
 * speakers and the guest mic from the HOST mic, so the acoustic segment of
 * this loop is Mac-speaker→room→Mac-mic — a real acoustic path exercising the
 * real app-path transport, but NOT target-hardware (Pixel 6a) acoustics.
 *
 * Usage:
 *   bun android-emulator-driver.mjs [--serial emulator-5554] [--out <dir>]
 *     [--skip-double-talk]
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argvArg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SERIAL = argvArg("--serial") ?? "emulator-5554";
const OUT = path.resolve(argvArg("--out") ?? ".");
const SKIP_DOUBLE_TALK = process.argv.includes("--skip-double-talk");
// Far-end speech played through the DEVICE speaker instead of on-device TTS —
// for builds where the local TTS engine is not provisioned (e.g. the emulator,
// which ships no eliza-1/kokoro bundle). Passed to the harness as an
// `audioUrl` data: URL (a data URL, not http, so the https://localhost WebView
// never trips mixed-content blocking). The acoustic loop — device speaker →
// air → device mic — and the production /api/voice/* transport are unchanged;
// only the speech source differs.
const FAR_END_WAV = argvArg("--far-end-wav");
const CDP_PORT = 9223;
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[android-driver] ${m}`);
const adb = (...args) =>
  execFileSync("adb", ["-s", SERIAL, ...args], { encoding: "utf8" });

// ── CDP plumbing ───────────────────────────────────────────────────────────
let ws = null;
let msgId = 0;
const pending = new Map();

async function cdpConnect() {
  const pid = adb("shell", "pidof", "ai.elizaos.app").trim();
  if (!pid) throw new Error("ai.elizaos.app not running");
  log(`app pid ${pid}`);
  adb(
    "forward",
    `tcp:${CDP_PORT}`,
    `localabstract:webview_devtools_remote_${pid}`,
  );
  const targets = await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
  ).json();
  const page = targets.find(
    (t) =>
      t.type === "page" && /localhost/.test(t.url) && t.webSocketDebuggerUrl,
  );
  if (!page) {
    throw new Error(
      `no localhost page target; got: ${targets.map((t) => `${t.type}:${t.url}`).join(", ")}`,
    );
  }
  log(`attaching to ${page.url}`);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
}

function cdp(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression, { awaitPromise = false } = {}) {
  const res = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    timeout: 300_000,
  });
  if (res.exceptionDetails) {
    throw new Error(
      `page exception: ${JSON.stringify(res.exceptionDetails).slice(0, 2000)}`,
    );
  }
  return res.result?.value;
}

/** Pull a large string property of window in chunks (CDP payload safety). */
async function pullLargeString(pageExpr) {
  const total = await evalJs(`(${pageExpr}).length`);
  const CHUNK = 512 * 1024;
  let out = "";
  for (let off = 0; off < total; off += CHUNK) {
    out += await evalJs(`(${pageExpr}).slice(${off}, ${off + CHUNK})`);
  }
  return out;
}

/** Push the far-end WAV to the page as a data: URL under window.__aecFarUrl.
 * Chunked so the CDP eval payload stays small. Returns the JS expression that
 * reads it back (or `undefined` when no far-end WAV was given → on-device TTS). */
async function stageFarEndUrl() {
  if (!FAR_END_WAV) return "undefined";
  const b64 = readFileSync(path.resolve(FAR_END_WAV)).toString("base64");
  const dataUrl = `data:audio/wav;base64,${b64}`;
  await evalJs(`window.__aecFarUrl = ""; void 0`);
  const CHUNK = 256 * 1024;
  for (let off = 0; off < dataUrl.length; off += CHUNK) {
    const part = dataUrl.slice(off, off + CHUNK);
    await evalJs(`window.__aecFarUrl += ${JSON.stringify(part)}; void 0`);
  }
  const len = await evalJs(`window.__aecFarUrl.length`);
  log(`staged far-end data URL (${len} chars) from ${FAR_END_WAV}`);
  return "window.__aecFarUrl";
}

// ── Run one loop pass ──────────────────────────────────────────────────────
async function runPass({ tag, doubleTalkText, farUrlExpr }) {
  log(`pass "${tag}": starting`);
  await evalJs(`window.__aecCapJson = null; void 0`);
  // Kick the run without awaiting it over CDP (long-running), stash JSON.
  await evalJs(
    `window.__aecRun = window.__aecLoop.run({ tag: ${JSON.stringify(tag)}, maxSeconds: 30, skipFileSink: true, audioUrl: ${farUrlExpr} })
       .then((r) => { window.__aecCapJson = JSON.stringify(r); return "ok"; })
       .catch((e) => { window.__aecCapJson = JSON.stringify({ error: String(e && e.stack || e) }); return "err"; }); void 0`,
  );

  // Wait for playback to begin so the double-talk speech overlaps the echo.
  const t0 = Date.now();
  for (;;) {
    const state = await evalJs(
      `JSON.stringify({ state: window.__aecLoop.state(), log: window.__aecLoop.log().slice(-3) })`,
    );
    const parsed = JSON.parse(state);
    if (parsed.log.some((l) => l.includes("play TTS"))) break;
    if (parsed.state === "error" || parsed.state === "done") break;
    if (Date.now() - t0 > 180_000)
      throw new Error("timeout waiting for playback");
    await new Promise((r) => setTimeout(r, 500));
  }

  let sayProc = null;
  if (doubleTalkText) {
    log(`pass "${tag}": speaking near-end from host (say)`);
    sayProc = spawn("say", ["-r", "175", doubleTalkText], { stdio: "ignore" });
  }

  // Wait for completion.
  for (;;) {
    const done = await evalJs(`window.__aecCapJson !== null`);
    if (done) break;
    if (Date.now() - t0 > 300_000) throw new Error("timeout waiting for loop");
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (sayProc) await new Promise((r) => sayProc.on("exit", r));

  log(`pass "${tag}": pulling result`);
  const json = await pullLargeString("window.__aecCapJson");
  const file = path.join(OUT, `aec-loop-result-${tag}.json`);
  writeFileSync(file, json);
  const parsed = JSON.parse(json);
  if (parsed.error) throw new Error(`pass "${tag}" failed: ${parsed.error}`);
  log(
    `pass "${tag}": done — micFrames=${parsed.micFramesSent} playFrames=${parsed.playFramesSent} ` +
      `counters=${JSON.stringify(parsed.statusAfter?.aec ?? {})}`,
  );
  return file;
}

// ── Main ───────────────────────────────────────────────────────────────────
log(`granting RECORD_AUDIO`);
try {
  adb(
    "shell",
    "pm",
    "grant",
    "ai.elizaos.app",
    "android.permission.RECORD_AUDIO",
  );
} catch (err) {
  log(`grant failed (may already hold it): ${err}`);
}

await cdpConnect();
const ready = await evalJs(`typeof window.__aecLoop`);
if (ready !== "object") {
  throw new Error(
    `window.__aecLoop not installed (got ${ready}) — is this build current?`,
  );
}

const farUrlExpr = await stageFarEndUrl();

const echoOnly = await runPass({
  tag: "echo-only",
  doubleTalkText: null,
  farUrlExpr,
});
let doubleTalk = null;
if (!SKIP_DOUBLE_TALK) {
  doubleTalk = await runPass({
    tag: "double-talk",
    doubleTalkText:
      "This is the near end talker. Please keep my words intact " +
      "while the canceller removes the agent's own voice. " +
      "Sphinx of black quartz, judge my vow.",
    farUrlExpr,
  });
}
log(`results: ${echoOnly}${doubleTalk ? ` + ${doubleTalk}` : ""}`);
ws?.close();
