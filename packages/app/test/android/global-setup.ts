// Global setup for the Android WebView e2e suite. Ensures a device is attached
// and the app is installed, pins ANDROID_SERIAL for the fixtures, and verifies
// the on-device agent is reachable — failing LOUDLY with a logcat snapshot when
// the local runtime did not come up (the user must know if local fails to
// start). It does NOT stage models or boot the agent itself; run the local
// bring-up (scripts/android-e2e.mjs, or mobile-local-chat-smoke) first.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adbReverse,
  adbTry,
  AGENT_API_PORT,
  isInstalled,
  launchApp,
  resolveAdb,
  resolveApk,
  resolveSerial,
} from "../../scripts/lib/android-device.mjs";

const HEALTH_POLL_MS = Number(process.env.ELIZA_ANDROID_HEALTH_TIMEOUT_MS ?? 180_000);
const REQUIRE_AGENT = process.env.ELIZA_ANDROID_REQUIRE_AGENT !== "0";
const BACKEND = (process.env.ELIZA_ANDROID_BACKEND ?? "local").toLowerCase();

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollAgentHealth(localPort: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${localPort}/api/health`, {
        headers: { "X-ElizaOS-Client-Id": "android-e2e-global-setup" },
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      last = { status: res.status, body };
      const ready =
        res.status === 200 &&
        (typeof body !== "object" ||
          body === null ||
          (body as { ready?: boolean }).ready !== false);
      if (ready) return last;
    } catch (error) {
      last = { error: String(error) };
    }
    await delay(2_000);
  }
  return { timedOut: true, last };
}

export default async function globalSetup() {
  const adb = resolveAdb();
  const serial = resolveSerial(adb, process.env.ANDROID_SERIAL);
  // Pin the serial so connectPlaywrightDevice + adb target the same device
  // (a physical phone may also be attached alongside the emulator).
  process.env.ANDROID_SERIAL = serial;
  console.log(`[android-e2e] device serial=${serial}`);

  if (!isInstalled(adb, serial)) {
    const apk = resolveApk(process.env.ELIZA_ANDROID_APK);
    console.log(`[android-e2e] installing ${apk}`);
    execFileSync(adb, ["-s", serial, "install", "-r", "-d", apk], {
      stdio: "inherit",
    });
  }

  // Pre-grant the runtime permissions the app requests on launch, so a system
  // GrantPermissionsActivity doesn't cover the WebView and stall route render.
  for (const perm of [
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.RECORD_AUDIO",
    "android.permission.CAMERA",
  ]) {
    adbTry(adb, ["-s", serial, "shell", "pm", "grant", "ai.elizaos.app", perm]);
  }

  // host backend: route the device's loopback :31337 to the host agent.
  if (BACKEND === "host") {
    adbReverse(adb, serial, AGENT_API_PORT, AGENT_API_PORT);
    console.log(
      `[android-e2e] host backend: adb reverse tcp:${AGENT_API_PORT} -> host:${AGENT_API_PORT}`,
    );
  }

  // Bring the app to the foreground so its WebView DevTools socket is live.
  launchApp(adb, serial);

  if (!REQUIRE_AGENT) {
    console.log("[android-e2e] ELIZA_ANDROID_REQUIRE_AGENT=0 — skipping health gate");
    return;
  }

  // host backend: the agent runs on the test host itself; poll it directly.
  // local backend: forward the on-device agent's port to a FREE host port (0)
  // and poll that — avoids colliding with anything already bound to host :31337.
  const pollPort =
    BACKEND === "host"
      ? AGENT_API_PORT
      : Number(
          adbTry(adb, [
            "-s",
            serial,
            "forward",
            "tcp:0",
            `tcp:${AGENT_API_PORT}`,
          ]).trim() || AGENT_API_PORT,
        );
  const where = BACKEND === "host" ? "host agent" : "on-device agent";
  console.log(
    `[android-e2e] waiting up to ${HEALTH_POLL_MS}ms for ${where} (127.0.0.1:${pollPort}/api/health)…`,
  );
  const health = await pollAgentHealth(pollPort, HEALTH_POLL_MS);
  if ((health as { timedOut?: boolean }).timedOut) {
    const logPath = path.join(os.tmpdir(), `android-e2e-logcat-${serial}.txt`);
    fs.writeFileSync(
      logPath,
      adbTry(adb, ["-s", serial, "logcat", "-d", "-t", "400"]),
    );
    throw new Error(
      `[android-e2e] ${where} never became healthy within ${HEALTH_POLL_MS}ms — the ${BACKEND} runtime failed to start. ` +
        (BACKEND === "host"
          ? "Start a host agent on :31337 (bun run dev) first. "
          : "Run the local bring-up first (bun run --cwd packages/app test:sim:local-chat:android:live) ") +
        `or set ELIZA_ANDROID_REQUIRE_AGENT=0. ` +
        `Logcat: ${logPath}. Last health: ${JSON.stringify((health as { last?: unknown }).last)}`,
    );
  }
  console.log(`[android-e2e] ${where} healthy: ${JSON.stringify(health)}`);
}
