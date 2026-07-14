#!/usr/bin/env node
/**
 * Drives an installed Android debug build through Eliza's assistant role,
 * voice-input IME, assist gesture, and assist-key surfaces (#13581).
 *
 * Reinstalling clears role and IME selection, so the lane reapplies and then
 * re-reads both. Explicit package-manager component queries cover services
 * without intent filters. Runtime proof comes from native logcat markers plus
 * resumed activity state. A debug-only focused editor raises the installed IME;
 * automation locates its real mic view, taps it, and requires either a committed
 * transcript or the designed unavailable state and its open-app route.
 *
 * `--require-device` rejects a missing device; `--require-engine` additionally
 * requires a committed transcript. Parser and verdict policy remain isolated in
 * the unit-tested library so malformed shell receipts cannot read as success.
 */
import {
  APP_PACKAGE,
  ASSIST_ACTIVITY_COMPONENT,
  ASSISTANT_IME_COMPONENT,
  ASSISTANT_RECOGNITION_COMPONENT,
  ASSISTANT_SESSION_COMPONENT,
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
  parseUiAutomatorBounds,
  parseVoiceInteractionService,
  ROLE_ASSISTANT,
  summarizeLaneVerdict,
} from "./lib/android-assistant-verify-lib.mjs";
import {
  adbDevice,
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
const log = (m) => {
  const line = `[android-assistant-verify] ${m}`;
  if (process.argv.includes("--json")) console.error(line);
  else console.log(line);
};

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
const IME_PROBE_COMPONENT = `${APP_PACKAGE}/.ElizaImeProbeActivity`;
const IME_MIC_RESOURCE_ID = `${APP_PACKAGE}:id/eliza_ime_mic`;

/** Run a required adb shell command; a non-zero status aborts the verifier. */
function sh(adb, serial, args) {
  return adbDevice(adb, serial, ["shell", ...args]).trim();
}

/** Clear the logcat ring so a subsequent scrape only sees this run's lines. */
function clearLogcat(adb, serial) {
  adbDevice(adb, serial, ["logcat", "-c"], { stdio: "ignore" });
}

/** Dump and return the current logcat buffer (bounded to the assistant tags). */
function dumpLogcat(adb, serial) {
  return adbDevice(adb, serial, [
    "logcat",
    "-d",
    "-v",
    "brief",
    "-s",
    `${LOG_TAGS.vis}:V`,
    `${LOG_TAGS.ime}:V`,
    "ElizaImeProbe:V",
    "ActivityTaskManager:I",
  ]);
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
    "--user",
    "0",
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

  // Resolver tables omit components with no intent filter, including the
  // paired session service. Explicit package-manager intents prove that each
  // installed component resolves, while the package dump remains a second,
  // independently useful receipt for filtered surfaces and metadata.
  const pkgDump = sh(adb, serial, ["dumpsys", "package", APP_PACKAGE]);
  const serviceComponents = [
    ASSISTANT_VIS_COMPONENT,
    ASSISTANT_SESSION_COMPONENT,
    ASSISTANT_RECOGNITION_COMPONENT,
    ASSISTANT_IME_COMPONENT,
  ];
  const serviceReceipts = Object.fromEntries(
    serviceComponents.map((component) => [
      component,
      sh(adb, serial, [
        "cmd",
        "package",
        "query-services",
        "--brief",
        "--components",
        "--user",
        "0",
        "-n",
        component,
      ]),
    ]),
  );
  const assistActivityReceipt = sh(adb, serial, [
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "--user",
    "0",
    "-n",
    ASSIST_ACTIVITY_COMPONENT,
  ]);
  const surfaces = parseAssistantSurfaces(
    [pkgDump, ...Object.values(serviceReceipts), assistActivityReceipt].join(
      "\n",
    ),
  );
  checks.surfaces = surfaces;
  checks.surfaceReceipts = { serviceReceipts, assistActivityReceipt };
  log(
    surfaces.allPresent
      ? "surfaces: VIS + session + recognition + IME + assist activity all registered"
      : `surfaces MISSING: ${surfaces.missing.join(", ")}`,
  );

  if (APPLY) applyRoleAndIme(adb, serial);

  // (2) Secure settings + role holders reflect Eliza.
  const roleOut = sh(adb, serial, [
    "cmd",
    "role",
    "get-role-holders",
    "--user",
    "0",
    ROLE_ASSISTANT,
  ]);
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
  const assistDump = sh(adb, serial, ["dumpsys", "activity", "activities"]);
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
  const keyDump = sh(adb, serial, ["dumpsys", "activity", "activities"]);
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

  // (3c) Raise the installed IME against a focused editor and tap its actual
  // mic affordance. On the engine-less emulator this must expose ENGINE_OFF and
  // route through the IME's own open-app deep link. On a full-engine device the
  // same tap starts the mic round-trip; a second tap stops capture so the lane
  // can require a committed transcript.
  clearLogcat(adb, serial);
  sh(adb, serial, ["am", "start", "-W", "-n", IME_PROBE_COMPONENT]);
  await sleep(3_500);
  const hierarchyPath = "/sdcard/eliza-ime-verifier-window.xml";
  sh(adb, serial, ["uiautomator", "dump", hierarchyPath]);
  const imeHierarchy = sh(adb, serial, ["cat", hierarchyPath]);
  sh(adb, serial, ["rm", "-f", hierarchyPath]);
  const imeUi = parseUiAutomatorBounds(imeHierarchy, IME_MIC_RESOURCE_ID);
  checks.imeUi = imeUi;
  log(`real IME mic affordance visible: ${imeUi.found}`);

  const imeStatusLog = dumpLogcat(adb, serial);
  let asrOutcome = classifyImeAsrOutcome(imeStatusLog);
  if (imeUi.center) {
    sh(adb, serial, [
      "input",
      "tap",
      String(imeUi.center.x),
      String(imeUi.center.y),
    ]);
    await sleep(2_500);
    if (asrOutcome === "unknown") {
      // A ready engine leaves the IME in IDLE; stop the real recording after a
      // non-trivial capture so its production transcription path executes.
      sh(adb, serial, [
        "input",
        "tap",
        String(imeUi.center.x),
        String(imeUi.center.y),
      ]);
      await sleep(32_500);
    }
  }
  const imeLog = dumpLogcat(adb, serial);
  asrOutcome = classifyImeAsrOutcome(`${imeStatusLog}\n${imeLog}`);
  const imeDump = sh(adb, serial, ["dumpsys", "activity", "activities"]);
  const imeLanded = assertDeepLinkLanded(
    imeDump,
    imeLog,
    DEEP_LINK_SOURCES.ime,
  );
  checks.imeLanded = imeLanded;
  checks.runtimeReceipts = { assistLog, keyLog, imeStatusLog, imeLog };
  log(
    `IME unavailable-state deep-link reached MainActivity: ${imeLanded.landed}`,
  );

  // (4) IME ASR round-trip classification (committed vs. designed ENGINE_OFF).
  checks.asrOutcome = asrOutcome;
  log(`IME ASR outcome: ${asrOutcome}`);

  const verdict = summarizeLaneVerdict(
    {
      surfacesRegistered: surfaces.allPresent,
      roleHeld: role.heldByExpected,
      imeSelected: imeSetting.isEliza && imeEnabled.elizaEnabled,
      voiceinteractionLanded: assistLanded.landed,
      assistKeyLanded: keyLanded,
      imeLanded: imeLanded.landed || asrOutcome === "committed",
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
    // error-policy:J1 command boundary translates missing tooling to the lane's explicit N/A/fail result.
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
  // error-policy:J1 process boundary preserves adb stderr and exits observably.
  finish({
    status: "fail",
    reason: `unhandled verifier error: ${error?.stack ?? error}`,
  });
});
