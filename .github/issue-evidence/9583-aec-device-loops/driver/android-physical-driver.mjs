#!/usr/bin/env bun
/**
 * #11373 — Android PHYSICAL device AEC acoustic-loop driver (Pixel-class).
 *
 * Drives the committed on-device harness (`window.__aecLoop`, installed by
 * packages/ui installAecLoopHarness on Android) inside the app's WebView over
 * CDP (adb `localabstract:webview_devtools_remote_<pid>`), runs the echo-only
 * and double-talk passes against the REAL device speaker → air → device mic
 * loop, and pulls the result JSONs (agent-side aec-capture + page PCM +
 * delivery counters) back to the host.
 *
 * Differences from android-emulator-driver.mjs:
 *  - the near-end (double-talk) speech is NOT spoken by the host (`say` is
 *    macOS-only and a headless Linux capture host may have no speakers).
 *    Instead it is played ON the device through a second HTMLAudioElement that
 *    is NOT connected to the harness's playback tap — so it reaches the mic
 *    acoustically but never enters the far-end reference, which is exactly the
 *    property that defines near-end speech for the canceller. Caveat (honest):
 *    it radiates from the same loudspeaker as the far-end rather than from a
 *    talker elsewhere in the room; it is still uncorrelated with the reference.
 *  - device prep: wake + dismiss keyguard + `pm grant RECORD_AUDIO` + media
 *    volume, all via adb — no human taps required on Android.
 *
 * Usage:
 *   bun android-physical-driver.mjs --serial <serial> [--out <dir>]
 *     [--far-end-wav <16k wav>] [--near-end-wav <16k wav>]
 *     [--volume <0..1 of max media volume, default 0.7>]
 *     [--skip-double-talk] [--skip-echo-only]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argvArg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SERIAL = argvArg("--serial");
if (!SERIAL) throw new Error("--serial <device serial> required");
const OUT = path.resolve(argvArg("--out") ?? ".");
const SKIP_DOUBLE_TALK = process.argv.includes("--skip-double-talk");
const SKIP_ECHO_ONLY = process.argv.includes("--skip-echo-only");
const FAR_END_WAV = argvArg("--far-end-wav");
const NEAR_END_WAV = argvArg("--near-end-wav");
const VOLUME_FRACTION = Number(argvArg("--volume") ?? "0.7");
const CDP_PORT = 9223;
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[android-physical-driver] ${m}`);
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

async function evalJs(
  expression,
  { awaitPromise = false, userGesture = false } = {},
) {
  const res = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise,
    userGesture,
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

/** Stage a WAV file on the page as a data: URL under the given window slot.
 * Chunked so each CDP eval payload stays small. Returns the JS expression that
 * reads it back, or `"undefined"` when no file was given. */
async function stageDataUrl(file, slot) {
  if (!file) return "undefined";
  const b64 = readFileSync(path.resolve(file)).toString("base64");
  const dataUrl = `data:audio/wav;base64,${b64}`;
  await evalJs(`window.${slot} = ""; void 0`);
  const CHUNK = 256 * 1024;
  for (let off = 0; off < dataUrl.length; off += CHUNK) {
    const part = dataUrl.slice(off, off + CHUNK);
    await evalJs(`window.${slot} += ${JSON.stringify(part)}; void 0`);
  }
  const len = await evalJs(`window.${slot}.length`);
  log(`staged ${slot} data URL (${len} chars) from ${file}`);
  return `window.${slot}`;
}

// ── Run one loop pass ──────────────────────────────────────────────────────
async function runPass({ tag, nearEnd, farUrlExpr }) {
  log(`pass "${tag}": starting`);
  await evalJs(`window.__aecCapJson = null; void 0`);
  // Kick the run without awaiting it over CDP (long-running), stash JSON.
  // The near-end (double-talk) speech is the harness's own nearEndAudioUrl
  // seam: same AudioContext, connected straight to the destination and NOT
  // through the playback tap — reaches the mic acoustically, absent from the
  // far-end reference. (A second CDP-created AudioContext renders silently on
  // Android WebView while the harness context holds the output stream, and
  // HTMLMediaElement rejects data: URLs — both verified on the Pixel 6a.)
  await evalJs(
    `window.__aecRun = window.__aecLoop.run({ tag: ${JSON.stringify(tag)}, maxSeconds: 40, skipFileSink: true, audioUrl: ${farUrlExpr}, nearEndAudioUrl: ${nearEnd ?? "undefined"} })
       .then((r) => { window.__aecCapJson = JSON.stringify(r); return "ok"; })
       .catch((e) => { window.__aecCapJson = JSON.stringify({ error: String(e && e.stack || e) }); return "err"; }); void 0`,
  );

  // Wait for completion.
  const t0 = Date.now();
  for (;;) {
    const done = await evalJs(`window.__aecCapJson !== null`);
    if (done) break;
    if (Date.now() - t0 > 300_000) throw new Error("timeout waiting for loop");
    await new Promise((r) => setTimeout(r, 1000));
  }

  log(`pass "${tag}": pulling result`);
  const json = await pullLargeString("window.__aecCapJson");
  const parsed = JSON.parse(json);
  if (parsed.error) throw new Error(`pass "${tag}" failed: ${parsed.error}`);
  if (nearEnd) {
    log(
      `pass "${tag}": near-end started=${parsed.nearEndStartedAtMs} duration=${parsed.nearEndDurationMs}ms`,
    );
  }
  const file = path.join(OUT, `aec-loop-result-${tag}.json`);
  writeFileSync(file, JSON.stringify(parsed));
  log(
    `pass "${tag}": done — micFrames=${parsed.micFramesSent} playFrames=${parsed.playFramesSent} ` +
      `counters=${JSON.stringify(parsed.statusAfter?.aec ?? {})}`,
  );
  return file;
}

// ── Main ───────────────────────────────────────────────────────────────────
log("device prep: wake, keyguard, mic grant, media volume");
adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
try {
  adb("shell", "wm", "dismiss-keyguard");
} catch (err) {
  log(`dismiss-keyguard failed (may be unlocked already): ${err}`);
}
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
// STREAM_MUSIC volume via volume-key events: `cmd media_session volume --set`
// claims success but does not apply on Pixel/Android 16 (observed on-device);
// KEYCODE_VOLUME_UP/DOWN actually move the stream. Read-verify loop.
const getVolume = () => {
  const info = adb(
    "shell",
    "cmd",
    "media_session",
    "volume",
    "--stream",
    "3",
    "--get",
  );
  const m = /volume is (\d+) in range \[\d+\.\.(\d+)\]/.exec(info);
  if (!m) throw new Error(`cannot parse stream volume: ${info}`);
  return { cur: Number(m[1]), max: Number(m[2]) };
};
const { max: maxVol } = getVolume();
const target = Math.max(1, Math.round(maxVol * VOLUME_FRACTION));
for (let guard = 0; guard < 60; guard += 1) {
  const { cur } = getVolume();
  if (cur === target) break;
  adb(
    "shell",
    "input",
    "keyevent",
    cur < target ? "KEYCODE_VOLUME_UP" : "KEYCODE_VOLUME_DOWN",
  );
  await new Promise((r) => setTimeout(r, 400));
}
log(`media volume set to ${getVolume().cur}/${maxVol}`);

await cdpConnect();
const ready = await evalJs(`typeof window.__aecLoop`);
if (ready !== "object") {
  throw new Error(
    `window.__aecLoop not installed (got ${ready}) — is this build current?`,
  );
}

const farUrlExpr = await stageDataUrl(FAR_END_WAV, "__aecFarUrl");
const nearUrlExpr = await stageDataUrl(NEAR_END_WAV, "__aecNearUrl");

let echoOnly = null;
if (!SKIP_ECHO_ONLY) {
  echoOnly = await runPass({ tag: "echo-only", nearEnd: null, farUrlExpr });
}
let doubleTalk = null;
if (!SKIP_DOUBLE_TALK) {
  if (nearUrlExpr === "undefined") {
    throw new Error("--near-end-wav required for the double-talk pass");
  }
  doubleTalk = await runPass({
    tag: "double-talk",
    nearEnd: nearUrlExpr,
    farUrlExpr,
  });
}
log(`results: ${[echoOnly, doubleTalk].filter(Boolean).join(" + ")}`);
ws?.close();
