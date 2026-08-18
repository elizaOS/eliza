/**
 * Pure decision logic behind the one-command iOS Simulator e2e orchestrator
 * (`ios-e2e.mjs`, wired as `test:e2e:ios`). The orchestrator itself is all
 * side effects — boot a simulator, build, `simctl install`, drive the auth and
 * full-Bun chat legs — so the parts worth testing are pulled out here as
 * deterministic functions with no I/O: CLI parsing, the ordered step plan a
 * given flag set produces, the "which simulator is booted" selection over
 * `simctl list … --json`, the app-id extraction, and the exact argv each leg
 * is invoked with.
 *
 * The load-bearing invariant these encode is the orchestrator's contract:
 * it must fail LOUDLY and must never report success vacuously. That is why
 * `planIosE2eSteps` distinguishes setup/optional cloud work from the two
 * simulator-app verification legs (auth / local-chat), and
 * `assertNonVacuousPlan` refuses a run that would print "ALL iOS E2E PASSED"
 * without exercising a single real app path. Runs under the packages/app vitest suite
 * (`bun run --cwd packages/app test`), i.e. the root test:client lane.
 */

export const DEFAULT_IOS_SIMULATOR = "iPhone 16 Pro";

// Ordered once, consumed everywhere. Build/install are setup; the rest are the
// real device-path assertions. Install remains explicit under --skip-build so
// a supplied App.app cannot be mistaken for an already-installed fresh build.
export const IOS_E2E_STEP_IDS = [
  "build",
  "install",
  "auth",
  "local-chat",
  "cloud",
];
export const IOS_E2E_VERIFICATION_STEP_IDS = ["auth", "local-chat"];

/**
 * Parse the orchestrator argv into an explicit flag record. Kept total (every
 * field always present) so callers branch on booleans, never on `argv.includes`
 * scattered through the flow.
 */
export function parseIosE2eArgs(argv) {
  const has = (flag) => argv.includes(flag);
  const val = (flag) => {
    const i = argv.indexOf(flag);
    const value = i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
    return value && !value.startsWith("--") ? value : undefined;
  };
  return {
    device: val("--device"),
    appPath: val("--app-path"),
    output: val("--output"),
    artifactSources: argv.flatMap((arg, index) => {
      const value = argv[index + 1];
      return arg === "--artifact-source" && value && !value.startsWith("--")
        ? [value]
        : [];
    }),
    skipBuild: has("--skip-build"),
    skipAuth: has("--skip-auth"),
    skipLocalChat: has("--skip-local-chat"),
    cloud: has("--cloud"),
    noWait: has("--no-wait"),
  };
}

/**
 * The ordered list of steps a flag set produces. Each descriptor carries a
 * stable `id`, a human `label`, and `verification: true` for the legs that
 * actually assert a real device path (so a plan can be checked for vacuity).
 */
export function planIosE2eSteps(flags) {
  const steps = [];
  if (!flags.skipBuild) {
    steps.push({
      id: "build",
      label: "build the iOS Simulator app",
      verification: false,
    });
  }
  steps.push({
    id: "install",
    label: "install the iOS Simulator app",
    verification: false,
  });
  if (!flags.skipAuth) {
    steps.push({
      id: "auth",
      label: "auth route: deep-link / callback registration + drive",
      verification: true,
    });
  }
  if (!flags.skipLocalChat) {
    steps.push({
      id: "local-chat",
      label: "local route: on-device agent + smallest model + real chat",
      verification: true,
    });
  }
  if (flags.cloud) {
    steps.push({
      id: "cloud",
      label: "cloud route: real provisioning probe",
      verification: false,
    });
  }
  return steps;
}

/**
 * Guard against a vacuous green: a run that skips every simulator-app
 * verification leg would otherwise sail to "ALL iOS E2E PASSED" having proven
 * no app/auth/chat path. Cloud is useful optional coverage, but it is not a
 * substitute for exercising the installed simulator app, so refuse those
 * combinations up front with an actionable message instead of exiting 0.
 */
export function assertNonVacuousPlan(steps) {
  const verifying = steps.filter((s) => s.verification);
  if (verifying.length === 0) {
    throw new Error(
      "refusing to run: every simulator-app verification leg (auth / local-chat) is skipped, " +
        "so the orchestrator would report success without proving the installed app path. " +
        "Drop --skip-auth or --skip-local-chat; --cloud alone is not enough.",
    );
  }
  return verifying;
}

/**
 * Select a booted simulator udid from the parsed output of
 * `xcrun simctl list devices booted --json`. Returns the first Booted device's
 * udid, or null when none is booted. Tolerant of the shape (missing `devices`,
 * non-array runtimes) because simctl JSON varies across Xcode versions.
 */
export function selectBootedUdid(listJson) {
  const devices = listJson?.devices;
  if (!devices || typeof devices !== "object") return null;
  for (const runtime of Object.values(devices)) {
    if (!Array.isArray(runtime)) continue;
    const booted = runtime.find((d) => d?.state === "Booted");
    if (booted?.udid) return booted.udid;
  }
  return null;
}

/** Resolve the target simulator name, defaulting to the pinned dev device. */
export function resolveTargetDevice(deviceArg) {
  return deviceArg ?? DEFAULT_IOS_SIMULATOR;
}

/**
 * Extract the Capacitor app id from `app.config.ts` source. The bundle id is
 * the `simctl` handle for install/terminate/uninstall, so a missing match falls
 * back to the known default rather than throwing mid-orchestration.
 */
export function extractAppId(configSrc) {
  return configSrc.match(/appId:\s*["']([^"']+)["']/)?.[1] ?? "ai.elizaos.app";
}

/** Extract the simulator's bundle and custom-scheme identities from app config. */
export function extractAppIdentity(configSrc) {
  const appId = extractAppId(configSrc);
  return {
    appId,
    urlScheme: configSrc.match(/urlScheme:\s*["']([^"']+)["']/)?.[1] ?? appId,
  };
}

/**
 * Describe the LaunchServices approval that lets `simctl openurl` deliver a
 * custom scheme without presenting an untappable simulator confirmation.
 */
export function iosSimulatorSchemeApproval({
  homeDir,
  udid,
  urlScheme,
  appId,
}) {
  if (!homeDir || !udid || !urlScheme || !appId) {
    throw new Error(
      "iOS scheme approval requires homeDir, udid, urlScheme, and appId",
    );
  }
  return {
    plistPath: `${homeDir}/Library/Developer/CoreSimulator/Devices/${udid}/data/Library/Preferences/com.apple.launchservices.schemeapproval.plist`,
    key: `com.apple.CoreSimulator.CoreSimulatorBridge-->${urlScheme}`,
    appId,
  };
}

/**
 * Apply one approval to the LaunchServices dictionary without discarding
 * approvals belonging to other installed apps.
 */
export function applyIosSimulatorSchemeApproval(entries, approval) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error("iOS simulator scheme approvals must be an object");
  }
  const previousAppId = entries[approval.key] ?? null;
  const changed = previousAppId !== approval.appId;
  return {
    entries: changed ? { ...entries, [approval.key]: approval.appId } : entries,
    previousAppId,
    changed,
  };
}

/**
 * Model the LaunchServices custom-scheme decision used by CoreSimulatorBridge.
 * A missing or wrong bundle-id mapping leaves the callback behind the system
 * confirmation sheet; the exact mapping lets the bridge deliver it to the app.
 */
export function classifyIosSimulatorSchemeDispatch(entries, approval) {
  return entries?.[approval.key] === approval.appId
    ? "deliver-to-app"
    : "confirmation-blocked";
}

// Leg command builders. Each returns { cmd, args } exactly as spawned. Kept
// pure so the tests pin the flags that make each leg *real* — e.g. the chat leg
// must carry --require-installed (no host fallback) and --ios-full-bun-smoke
// (the real on-device engine), and the auth leg must target the booted udid.

export function buildIosSimBuildCommand() {
  return { cmd: "bun", args: ["run", "build:ios:local:sim"] };
}

export function buildAuthSmokeCommand(udid) {
  if (!udid) throw new Error("buildAuthSmokeCommand requires a simulator udid");
  return {
    cmd: "node",
    args: [
      "../../packages/app-core/scripts/mobile-auth-simulator-smoke.mjs",
      "--platform",
      "ios",
      "--device",
      udid,
    ],
  };
}

/**
 * Extract the auth smoke's final structured payload from its mixed human/JSON
 * stdout. The auth CLI deliberately keeps stdout as its stable interface; the
 * composed runner persists this exact object without adding a second evidence
 * mode to the platform-neutral auth harness.
 */
export function parseAuthSmokeResult(stdout) {
  const text = String(stdout ?? "").trim();
  const starts = [0];
  for (
    let index = text.indexOf("\n{");
    index >= 0;
    index = text.indexOf("\n{", index + 2)
  ) {
    starts.push(index + 1);
  }
  for (const start of starts.reverse()) {
    try {
      const value = JSON.parse(text.slice(start));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {
      // error-policy:J3 Earlier braces may belong to human log lines; only a
      // complete trailing JSON object is a valid auth receipt.
    }
  }
  throw new Error("mobile auth smoke stdout did not end with a JSON object");
}

export function buildLocalChatSmokeCommand() {
  return {
    cmd: "node",
    args: [
      "scripts/mobile-local-chat-smoke.mjs",
      "--platform",
      "ios",
      "--require-installed",
      "--ios-select-local",
      "--ios-full-bun-smoke",
    ],
  };
}

export function buildCloudProvisioningCommand() {
  return { cmd: "node", args: ["scripts/cloud-provisioning-e2e.mjs"] };
}

/**
 * Classify a spawned leg's exit status into the loud-or-pass decision. A
 * non-zero (or null, i.e. killed by signal) status is a hard failure that must
 * abort the whole orchestration — never a warn-and-continue.
 */
export function classifyStepExit(status) {
  if (status === 0) return { ok: true };
  return {
    ok: false,
    reason:
      status === null ? "terminated by signal" : `exited with code ${status}`,
  };
}

/** Whether a `simctl get_app_container` result proves the app is installed. */
export function isAppInstalled(container) {
  return typeof container === "string" && container.trim().length > 0;
}
