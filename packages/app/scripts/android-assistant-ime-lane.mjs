#!/usr/bin/env node
/**
 * android-assistant-ime-lane (#13581) — an automated, repeatable adb-driven
 * regression lane for Eliza's Android assistant surface that works on a
 * **retail/sideload** build (unlike `ElizaOsInstrumentedTest`, which is
 * `assumeSystemEliza()`-gated and assume-skips vacuously off `/system/priv-app/`).
 *
 * Every `adb install -r` clears the assistant role and the enabled/selected IME,
 * so this lane, run AFTER install:
 *   1. re-applies the ASSISTANT role + the Eliza voice IME
 *      (`cmd role add-role-holder`, `ime enable`/`ime set`);
 *   2. asserts the secure settings landed
 *      (`settings get secure voice_interaction_service` / `default_input_method`);
 *   3. fires the assistant (`cmd voiceinteraction show`) and the AOSP assistant
 *      key (`input keyevent KEYCODE_ASSIST`);
 *   4. asserts via logcat + `dumpsys activity` that the Eliza voice session
 *      deep-link (`elizaos://voice?source=android-assistant-session` /
 *      `…=android-ime`) reached MainActivity — not a silent no-op.
 *
 * The command construction + settings/logcat/dumpsys parsing are pure functions
 * with an injectable `exec`, so the contract is unit-tested without a device
 * (`android-assistant-ime-lane.test.mjs`); the live emulator/device run
 * (`--serial <s>`) is the Needs-agent-verify step.
 */

import { spawnSync } from "node:child_process";

export const ASSISTANT_ROLE = "android.app.role.ASSISTANT";
export const DEFAULT_PACKAGE = "ai.elizaos.app";
export const DEFAULT_IME_ID = "ai.elizaos.app/.ElizaVoiceInputMethodService";
export const ASSIST_SESSION_DEEPLINK =
  "elizaos://voice?source=android-assistant-session";
export const IME_SESSION_DEEPLINK = "elizaos://voice?source=android-ime";
export const MAIN_ACTIVITY = "MainActivity";

function defaultExec(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  return {
    status: r.status ?? -1,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

/** An adb runner bound to a serial. `exec(bin, args) => {status, stdout, stderr}` is injectable. */
export function makeAdb(serial, exec = defaultExec, bin = "adb") {
  if (!serial) throw new Error("makeAdb: a device serial is required.");
  return (args) => exec(bin, ["-s", serial, ...args]);
}

/** The exact adb arg vectors to re-apply the assistant role + voice IME. */
export function reapplyCommands(pkg = DEFAULT_PACKAGE, imeId = DEFAULT_IME_ID) {
  return {
    role: ["shell", "cmd", "role", "add-role-holder", ASSISTANT_ROLE, pkg],
    imeEnable: ["shell", "ime", "enable", imeId],
    imeSet: ["shell", "ime", "set", imeId],
  };
}

/** Read a secure setting and assert its value contains `expectSubstr`. */
export function assertSecureSetting(adb, key, expectSubstr) {
  const res = adb(["shell", "settings", "get", "secure", key]);
  const value = (res.stdout || "").trim();
  return {
    key,
    value,
    expectSubstr,
    // adb prints the literal string "null" for an unset secure setting.
    ok: value !== "" && value !== "null" && value.includes(expectSubstr),
  };
}

/**
 * True when the voice-session deep-link both appears in the captured
 * logcat/dumpsys text AND is associated with MainActivity — i.e. the assistant
 * key / voiceinteraction actually routed into the Eliza activity rather than
 * being swallowed.
 */
export function sessionLanded(text, deeplink) {
  if (!text) return false;
  return text.includes(deeplink) && text.includes(MAIN_ACTIVITY);
}

/**
 * Run the full lane. Returns a structured result (never throws on assertion
 * failure — the caller decides exit code) so a canary (rename the VIS service)
 * turns it red deterministically.
 */
export async function runLane({
  serial,
  exec,
  pkg = DEFAULT_PACKAGE,
  imeId = DEFAULT_IME_ID,
}) {
  const adb = makeAdb(serial, exec);
  const cmds = reapplyCommands(pkg, imeId);

  // 1. re-apply role + IME (cleared by `adb install -r`).
  adb(cmds.role);
  adb(cmds.imeEnable);
  adb(cmds.imeSet);

  // 2. assert the secure settings landed.
  const vis = assertSecureSetting(adb, "voice_interaction_service", pkg);
  const dim = assertSecureSetting(adb, "default_input_method", imeId);

  // 3. Fire each route in its own log window so one working assistant entry
  // point cannot hide another broken one.
  adb(["logcat", "-c"]);
  adb(["shell", "cmd", "voiceinteraction", "show"]);
  const assistCaptured =
    (adb(["logcat", "-d"]).stdout || "") +
    "\n" +
    (adb(["shell", "dumpsys", "activity", "activities"]).stdout || "");
  const voiceinteractionLanded = sessionLanded(
    assistCaptured,
    ASSIST_SESSION_DEEPLINK,
  );

  adb(["logcat", "-c"]);
  adb(["shell", "input", "keyevent", "KEYCODE_ASSIST"]);
  const keyCaptured =
    (adb(["logcat", "-d"]).stdout || "") +
    "\n" +
    (adb(["shell", "dumpsys", "activity", "activities"]).stdout || "");
  const assistKeyLanded = sessionLanded(keyCaptured, ASSIST_SESSION_DEEPLINK);

  // The IME path is triggered as a direct view intent because headless CI often
  // has no focused editor to raise the keyboard.
  adb(["logcat", "-c"]);
  adb([
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `${IME_SESSION_DEEPLINK}&action=voice&voice=1`,
    `${pkg}/.MainActivity`,
  ]);
  const imeCaptured =
    (adb(["logcat", "-d"]).stdout || "") +
    "\n" +
    (adb(["shell", "dumpsys", "activity", "activities"]).stdout || "");
  const imeLanded = sessionLanded(imeCaptured, IME_SESSION_DEEPLINK);

  const failures = [];
  if (!vis.ok) {
    failures.push(
      `secure voice_interaction_service='${vis.value}' does not reference ${pkg} — assistant role not applied`,
    );
  }
  if (!dim.ok) {
    failures.push(
      `secure default_input_method='${dim.value}' is not ${imeId} — voice IME not selected`,
    );
  }
  if (!voiceinteractionLanded) {
    failures.push(
      `cmd voiceinteraction show did not route ${ASSIST_SESSION_DEEPLINK} into ${MAIN_ACTIVITY}`,
    );
  }
  if (!assistKeyLanded) {
    failures.push(
      `KEYCODE_ASSIST did not route ${ASSIST_SESSION_DEEPLINK} into ${MAIN_ACTIVITY}`,
    );
  }
  if (!imeLanded) {
    failures.push(
      `IME open-app path did not route ${IME_SESSION_DEEPLINK} into ${MAIN_ACTIVITY}`,
    );
  }
  return {
    ok: failures.length === 0,
    vis,
    dim,
    voiceinteractionLanded,
    assistKeyLanded,
    imeLanded,
    failures,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--serial") args.serial = argv[++i];
    else if (a === "--package") args.pkg = argv[++i];
    else if (a === "--ime-id") args.imeId = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.serial) {
    console.error(
      "android-assistant-ime-lane --serial <device> [--package <pkg>] [--ime-id <id>]",
    );
    process.exit(2);
  }
  const result = await runLane(args);
  console.log(
    `[assistant-ime] voice_interaction_service: ${result.vis.ok ? "OK" : "FAIL"} (${result.vis.value})`,
  );
  console.log(
    `[assistant-ime] default_input_method:      ${result.dim.ok ? "OK" : "FAIL"} (${result.dim.value})`,
  );
  console.log(
    `[assistant-ime] cmd voiceinteraction → MainActivity: ${result.voiceinteractionLanded ? "OK" : "FAIL"}`,
  );
  console.log(
    `[assistant-ime] KEYCODE_ASSIST → MainActivity: ${result.assistKeyLanded ? "OK" : "FAIL"}`,
  );
  if (!result.ok) {
    for (const f of result.failures) console.error(`[assistant-ime] ✗ ${f}`);
    process.exit(1);
  }
  console.log("[assistant-ime] lane passed.");
}

if (process.argv[1]?.endsWith("android-assistant-ime-lane.mjs")) {
  main().catch((err) => {
    console.error(
      `[assistant-ime] ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  });
}
