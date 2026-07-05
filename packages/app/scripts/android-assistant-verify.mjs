#!/usr/bin/env node
/**
 * Automated, repeatable adb-driven verification lane for Eliza's Android
 * assistant surfaces (issue #13581): the ROLE_ASSISTANT VoiceInteractionService,
 * the voice-input IME, and the assist-key / assist-gesture routing. It is the
 * regression lane the surfaces shipped without — every `adb install -r` clears
 * the assistant role and the enabled/selected IME, so a dev-loop reinstall
 * silently un-configures the surface and, until now, nothing noticed.
 *
 * What it does, against whatever build is installed on the attached device:
 *   1. Assert the manifest-declared surfaces survived install-time parsing —
 *      the VIS/session/recognition services, the IME service, the assist
 *      activity — via `dumpsys package` (a rejected VoiceInteractionServiceInfo
 *      never registers, so this catches a broken manifest as a hard failure).
 *   2. Re-apply the assistant role (`cmd role add-role-holder …ASSISTANT`) and
 *      the IME (`ime enable` + `ime set`) that a reinstall clears, then assert
 *      the secure settings (`voice_interaction_service`, `default_input_method`).
 *   3. Fire the assistant (`cmd voiceinteraction show`), the assist key
 *      (`input keyevent KEYCODE_ASSIST`), and the IME open-app path, and assert
 *      via logcat + `dumpsys activity` that the Eliza deep-link
 *      (`elizaos://voice?source=android-assistant-session` / `…=android-ime`)
 *      lands in MainActivity.
 *   4. Classify the IME ASR round-trip: a committed transcript when a full
 *      engine is up, or the designed ENGINE_OFF state when it is not — asserted,
 *      never skipped silently.
 *
 * Honest device gating (never green-by-skip): with NO device attached the lane
 * prints an N/A verdict and exits 0 — UNLESS `ELIZA_ANDROID_REQUIRE_AGENT=1`
 * (or `--require-device`), which makes a missing device a hard failure (exit 1).
 * The ASR engine is gated SEPARATELY (`--require-engine` /
 * `ELIZA_ANDROID_REQUIRE_ENGINE=1`): only then does an ENGINE_OFF ASR outcome
 * fail — the engine-less emulator leaves it unset and asserts the designed
 * ENGINE_OFF state instead. All decision logic lives in the pure, unit-tested
 * `android-assistant-verify-lib.mjs`; this file only runs adb and feeds its
 * stdout to those parsers.
 *
 * Flags: --serial <s>  --require-device  --require-engine  --json  --no-apply
 * Env:   ANDROID_SERIAL, ELIZA_ANDROID_REQUIRE_AGENT, ELIZA_ANDROID_REQUIRE_ENGINE
 */
import {
  APP_PACKAGE,
  ASSISTANT_IME_COMPONENT,
  ASSISTANT_VIS_COMPONENT,
  assertDeepLinkLanded,
  classifyImeAsrOutcome,
  DEEP_LINK_SOURCES,
  detectSurfaceInvocation,
  LOG_TAGS,
  parseAssistantSurfaces,
  parseDefaultInputMethod,
  parseEnabledImes,
  parseRoleHolders,
  parseVoiceInteractionService,
  ROLE_ASSISTANT,
  summarizeLaneVerdict,
} from "./lib/android-assistant-verify-lib.mjs";
import {
  adbTry,
  ensureEmulatorPermissive,
  isInstalled,
  listDevices,
  resolveAdb,
  resolveSerial,
} from "./lib/android-device.mjs";

const has = (flag) => process.argv.includes(flag);
const val = (flag, fb) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fb;
};
const log = (m) => console.log(`[android-assistant-verify] ${m}`);

// Two INDEPENDENT gates — do not conflate them.
//  REQUIRE_DEVICE governs device presence: a required-but-missing device is a
//    hard failure (the #13581 "never green-by-skip" ask). Also set by
//    ELIZA_ANDROID_REQUIRE_AGENT, the repo's standing "the device/agent must be
//    real" flag used across the android lanes.
//  REQUIRE_ENGINE governs the on-device ASR engine: when set, an ENGINE_OFF IME
//    ASR outcome fails. It is SEPARATE because the emulator carries no engine —
//    on a full-engine build (or a real device with a staged model) set it to
//    require a committed transcript; on the engine-less emulator leave it unset
//    so the lane asserts the designed ENGINE_OFF state instead.
const REQUIRE_DEVICE =
  has("--require-device") ||
  process.env.ELIZA_ANDROID_REQUIRE_AGENT === "1" ||
  process.env.ELIZA_ANDROID_REQUIRE_AGENT === "true";
const REQUIRE_ENGINE =
  has("--require-engine") ||
  process.env.ELIZA_ANDROID_REQUIRE_ENGINE === "1" ||
  process.env.ELIZA_ANDROID_REQUIRE_ENGINE === "true";
const APPLY = !has("--no-apply");
const JSON_OUT = has("--json");

const IME_COMPONENT = ASSISTANT_IME_COMPONENT;
const VIS_COMPONENT = ASSISTANT_VIS_COMPONENT;

/** Run an adb shell command on the device, returning trimmed stdout (or "" on failure). */
function sh(adb, serial, args) {
  return adbTry(adb, ["-s", serial, "shell", ...args]).trim();
}

/** Clear the logcat ring so a subsequent scrape only sees this run's lines. */
function clearLogcat(adb, serial) {
  adbTry(adb, ["-s", serial, "logcat", "-c"], { stdio: "ignore" });
}

/** Dump and return the current logcat buffer (bounded to the assistant tags). */
function dumpLogcat(adb, serial) {
  return adbTry(adb, ["-s", serial, "logcat", "-d", "-v", "brief"]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-apply the assistant role + IME a reinstall clears. Idempotent: re-running
 * on an already-configured device is a no-op. Emulators are rooted by
 * ensureEmulatorPermissive so `cmd role add-role-holder` succeeds; on a retail
 * device without root the grant may be refused — the subsequent secure-settings
 * assertion is what turns that into a visible failure rather than a false pass.
 */
function applyRoleAndIme(adb, serial) {
  log("re-applying assistant role + IME (cleared by adb install -r)…");
  // The role grant needs the role framework; --user 0 targets the primary user.
  sh(adb, serial, [
    "cmd",
    "role",
    "add-role-holder",
    ROLE_ASSISTANT,
    APP_PACKAGE,
  ]);
  sh(adb, serial, [
    "settings",
    "put",
    "secure",
    "voice_interaction_service",
    VIS_COMPONENT,
  ]);
  sh(adb, serial, ["settings", "put", "secure", "assistant", VIS_COMPONENT]);
  sh(adb, serial, ["ime", "enable", IME_COMPONENT]);
  sh(adb, serial, ["ime", "set", IME_COMPONENT]);
}

async function verifyOnDevice(adb, serial) {
  const checks = {};

  // (1) Surfaces registered — dumpsys package for the app, then fall back to a
  // full package dump if the per-package form is unavailable on this image.
  let pkgDump = adbTry(adb, [
    "-s",
    serial,
    "shell",
    "dumpsys",
    "package",
    APP_PACKAGE,
  ]);
  if (!pkgDump.includes(APP_PACKAGE)) {
    pkgDump = adbTry(adb, ["-s", serial, "shell", "dumpsys", "package"]);
  }
  const surfaces = parseAssistantSurfaces(pkgDump);
  checks.surfaces = surfaces;
  log(
    surfaces.allPresent
      ? "surfaces: VIS + session + recognition + IME + assist activity all registered"
      : `surfaces MISSING: ${surfaces.missing.join(", ")}`,
  );

  if (APPLY) applyRoleAndIme(adb, serial);

  // (2) Secure settings + role holders reflect Eliza.
  const roleOut = sh(adb, serial, ["cmd", "role", "holders", ROLE_ASSISTANT]);
  const role = parseRoleHolders(roleOut);
  const visSetting = parseVoiceInteractionService(
    sh(adb, serial, ["settings", "get", "secure", "voice_interaction_service"]),
  );
  const imeSetting = parseDefaultInputMethod(
    sh(adb, serial, ["settings", "get", "secure", "default_input_method"]),
  );
  const imeEnabled = parseEnabledImes(sh(adb, serial, ["ime", "list", "-s"]));
  checks.role = role;
  checks.visSetting = visSetting;
  checks.imeSetting = imeSetting;
  checks.imeEnabled = imeEnabled;
  log(`role held by Eliza: ${role.heldByExpected}`);
  log(`voice_interaction_service is Eliza: ${visSetting.isEliza}`);
  log(
    `default_input_method is Eliza IME: ${imeSetting.isEliza} (enabled: ${imeEnabled.elizaEnabled})`,
  );

  // (3a) Assist-gesture invocation via cmd voiceinteraction show.
  clearLogcat(adb, serial);
  sh(adb, serial, ["cmd", "voiceinteraction", "show"]);
  await sleep(2_500);
  const assistLog = dumpLogcat(adb, serial);
  const assistDump = adbTry(adb, [
    "-s",
    serial,
    "shell",
    "dumpsys",
    "activity",
    "activities",
  ]);
  const visInvoked = detectSurfaceInvocation(assistLog, {
    tag: LOG_TAGS.vis,
    bracket: "ElizaVoiceInteractionSession",
    source: DEEP_LINK_SOURCES.assistantSession,
  });
  const assistLanded = assertDeepLinkLanded(
    assistDump,
    assistLog,
    DEEP_LINK_SOURCES.assistantSession,
  );
  checks.visInvoked = visInvoked;
  checks.voiceinteractionLanded = assistLanded;

  // (3b) Hardware assist key: input keyevent KEYCODE_ASSIST → should reach the
  // VIS session (role held) or the ACTION_ASSIST fallback activity.
  clearLogcat(adb, serial);
  sh(adb, serial, ["input", "keyevent", "KEYCODE_ASSIST"]);
  await sleep(2_500);
  const keyLog = dumpLogcat(adb, serial);
  const keyDump = adbTry(adb, [
    "-s",
    serial,
    "shell",
    "dumpsys",
    "activity",
    "activities",
  ]);
  const keySessionLanded = assertDeepLinkLanded(
    keyDump,
    keyLog,
    DEEP_LINK_SOURCES.assistantSession,
  );
  const keyAssistLanded = assertDeepLinkLanded(
    keyDump,
    keyLog,
    DEEP_LINK_SOURCES.assist,
  );
  const keyLanded = keySessionLanded.landed || keyAssistLanded.landed;
  checks.assistKeyLanded = keyLanded;
  checks.assistKeySessionLanded = keySessionLanded;
  checks.assistKeyActivityLanded = keyAssistLanded;
  log(`assist key (KEYCODE_ASSIST) reached Eliza: ${keyLanded}`);

  // (3c) IME invocation → open-app deep link. Fire the IME's open-Eliza intent
  // directly (elizaos://voice?source=android-ime) so the entry point runs even
  // headless where no editor has focus to raise the keyboard.
  clearLogcat(adb, serial);
  adbTry(adb, [
    "-s",
    serial,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `elizaos://voice?source=${DEEP_LINK_SOURCES.ime}&action=voice&voice=1`,
    `${APP_PACKAGE}/.MainActivity`,
  ]);
  await sleep(2_500);
  const imeLog = dumpLogcat(adb, serial);
  const imeDump = adbTry(adb, [
    "-s",
    serial,
    "shell",
    "dumpsys",
    "activity",
    "activities",
  ]);
  const imeLanded = assertDeepLinkLanded(
    imeDump,
    imeLog,
    DEEP_LINK_SOURCES.ime,
  );
  checks.imeLanded = imeLanded;
  log(`IME deep-link reached MainActivity: ${imeLanded.landed}`);

  // (4) IME ASR round-trip classification (committed vs. designed ENGINE_OFF).
  const asrOutcome = classifyImeAsrOutcome(`${imeLog}\n${assistLog}`);
  checks.asrOutcome = asrOutcome;
  log(`IME ASR outcome: ${asrOutcome}`);

  const verdict = summarizeLaneVerdict(
    {
      surfacesRegistered: surfaces.allPresent,
      roleHeld: role.heldByExpected,
      imeSelected: imeSetting.isEliza && imeEnabled.elizaEnabled,
      voiceinteractionLanded: assistLanded.landed,
      assistKeyLanded: keyLanded,
      imeLanded: imeLanded.landed,
      asrOutcome,
    },
    REQUIRE_ENGINE,
  );
  checks.verdict = verdict;
  return checks;
}

async function main() {
  let adb;
  try {
    adb = resolveAdb();
  } catch (error) {
    return finish({
      status: "na",
      reason: `adb unavailable: ${error.message}`,
    });
  }

  const devices = listDevices(adb);
  if (devices.length === 0) {
    return finish({
      status: "na",
      reason:
        "no Android device/emulator attached — assistant/IME/assist-key checks need a device.",
    });
  }

  const serial = resolveSerial(
    adb,
    val("--serial", process.env.ANDROID_SERIAL),
  );
  process.env.ANDROID_SERIAL = serial;
  log(`device serial=${serial}`);
  await ensureEmulatorPermissive(adb, serial, { log });

  if (!isInstalled(adb, serial)) {
    return finish({
      status: REQUIRE_DEVICE ? "fail" : "na",
      reason: `${APP_PACKAGE} not installed on ${serial}. Install the app APK first (bun run --cwd packages/app install:android:adb).`,
    });
  }

  const checks = await verifyOnDevice(adb, serial);
  return finish({
    status: checks.verdict.pass ? "pass" : "fail",
    serial,
    requireDevice: REQUIRE_DEVICE,
    checks,
  });
}

function finish(result) {
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  }
  if (result.status === "na") {
    if (REQUIRE_DEVICE) {
      console.error(
        `[android-assistant-verify] REQUIRED device missing: ${result.reason}`,
      );
      process.exit(1);
    }
    log(`N/A (skipped honestly): ${result.reason}`);
    process.exit(0);
  }
  if (result.status === "fail") {
    console.error(
      `[android-assistant-verify] FAILED: ${
        result.reason ??
        result.checks?.verdict?.failures?.join("; ") ??
        "verification failed"
      }`,
    );
    process.exit(1);
  }
  log("PASSED ✅ Android assistant-role / IME / assist-key verification");
  process.exit(0);
}

main().catch((error) => {
  console.error(`[android-assistant-verify] ERROR: ${error?.stack ?? error}`);
  process.exit(1);
});
