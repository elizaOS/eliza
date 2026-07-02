/**
 * Mobile lane stamp — pure decision logic for the mobile build-lane guard
 * (issue #11030).
 *
 * The renderer bundle carries a machine-readable build stamp
 * (`dist/eliza-renderer-build.json`, written by the vite
 * `renderer-build-manifest` plugin) with `variant`, `capacitorTarget`, and
 * `runtimeMode`. Issue #11030's root operational cause: a cloud/store renderer
 * left in `packages/app/dist` by one lane was cap-synced into a DIFFERENT lane
 * (`build:ios:local`), so the device booted a cloud-mode bundle with no agent
 * endpoint and hung at "Booting up…".
 *
 * This module answers four questions without touching the filesystem, so all
 * are unit-testable:
 *   1. `resolveExpectedRendererStamp` — what stamp will THIS lane bake, given
 *      its `resolveMobileBuildPolicy()` output and the process env?
 *   2. `rendererLaneStampMismatches` — does an existing dist stamp match that
 *      expectation?
 *   3. `evaluateIosLocalLaneRuntime` — is a runtime mode (expected or from a
 *      dist stamp) safe for the ios-local lane to bake at all?
 *   4. `evaluateStagedIosSideloadBundle` — is the bundle already staged into
 *      the native iOS project safe to sideload onto a device?
 *
 * `run-mobile-build.mjs` uses (1) to drive the dist-reuse decision (a
 * wrong-lane dist triggers an automatic rebuild instead of being reused) and
 * (1)+(2)+(3) as a hard pre-Capacitor-sync assert so a mismatched bundle is
 * never silently baked into the native project.
 * `packages/app/scripts/mobile-release-preflight.mjs` uses (4) for the
 * sideload lane.
 */

/**
 * Compute the renderer stamp a `buildWeb(platform)` invocation will produce.
 *
 * Reproduces exactly (a) the env `buildWeb()` composes for the vite renderer
 * build in `run-mobile-build.mjs`, and (b) the precedence the vite
 * `renderer-build-manifest` plugin uses when writing the stamp
 * (`VITE_ELIZA_IOS_RUNTIME_MODE ?? VITE_ELIZA_ANDROID_RUNTIME_MODE ??
 * ELIZA_RUNTIME_MODE`). Keep the three in lockstep — this function is the
 * single source of truth for "what should dist say for this lane".
 *
 * @param {{ policy: { buildVariant: string, capacitorTarget: string|null,
 *           iosRuntimeMode: string|null, androidRuntimeMode: string|null,
 *           runtimeExecutionMode: string|null },
 *           env?: Record<string, string|undefined> }} opts
 * @returns {{ variant: string, capacitorTarget: string|null, runtimeMode: string|null }}
 */
export function resolveExpectedRendererStamp({ policy, env = {} }) {
  if (!policy || typeof policy !== "object") {
    throw new Error("resolveExpectedRendererStamp: policy is required");
  }
  // buildWeb: ELIZA_BUILD_VARIANT: process.env.ELIZA_BUILD_VARIANT || buildVariant
  const variant = env.ELIZA_BUILD_VARIANT || policy.buildVariant;
  // buildWeb always sets ELIZA_CAPACITOR_BUILD_TARGET from the policy.
  const capacitorTarget = policy.capacitorTarget ?? null;
  // buildWeb: an explicitly pre-set VITE_ELIZA_IOS_RUNTIME_MODE wins over the
  // iOS policy default; the Android policy value is set unconditionally.
  const viteIosRuntimeMode =
    policy.iosRuntimeMode != null
      ? env.VITE_ELIZA_IOS_RUNTIME_MODE || policy.iosRuntimeMode
      : env.VITE_ELIZA_IOS_RUNTIME_MODE;
  const viteAndroidRuntimeMode =
    policy.androidRuntimeMode != null
      ? policy.androidRuntimeMode
      : env.VITE_ELIZA_ANDROID_RUNTIME_MODE;
  const executionMode =
    policy.runtimeExecutionMode != null
      ? policy.runtimeExecutionMode
      : env.ELIZA_RUNTIME_MODE;
  const runtimeMode =
    viteIosRuntimeMode ?? viteAndroidRuntimeMode ?? executionMode ?? null;
  return { variant, capacitorTarget, runtimeMode };
}

function describeStampValue(value) {
  return value == null ? "(unset)" : `'${value}'`;
}

/**
 * Compare a renderer build manifest against the expected lane stamp.
 * Returns a list of human-readable mismatches; empty means the dist renderer
 * carries exactly the stamp this lane should bake.
 *
 * @param {{ variant?: string|null, capacitorTarget?: string|null,
 *           runtimeMode?: string|null } | null} manifest
 * @param {{ variant: string|null, capacitorTarget: string|null,
 *           runtimeMode: string|null }} expected
 * @returns {string[]}
 */
export function rendererLaneStampMismatches(manifest, expected) {
  if (!manifest) {
    return [
      "no renderer build manifest in dist (the renderer was not built with the renderer-build-manifest plugin)",
    ];
  }
  const mismatches = [];
  const fields = [
    ["variant", "variant"],
    ["capacitorTarget", "capacitor target"],
    ["runtimeMode", "runtime mode"],
  ];
  for (const [key, label] of fields) {
    const actual = manifest[key] ?? null;
    const wanted = expected[key] ?? null;
    if (actual !== wanted) {
      mismatches.push(
        `dist ${label} is ${describeStampValue(actual)} but this lane bakes ${describeStampValue(wanted)}`,
      );
    }
  }
  return mismatches;
}

/**
 * The runtime-mode values the native iOS AgentPlugin treats as "local" —
 * mirror of the `isLocalAgentMode` switch in
 * `plugins/plugin-native-agent/ios/Sources/AgentPlugin/AgentPlugin.swift`.
 * Any other mode requires a configured HTTP endpoint or the native agent
 * reports `state:"error"` and the renderer hangs at "Booting up…" (#11030).
 */
export const LOCAL_AGENT_RUNTIME_MODES = Object.freeze([
  "local",
  "ios-local",
  "sideload-local",
  "dev-local",
]);

export function isLocalAgentRuntimeMode(mode) {
  return LOCAL_AGENT_RUNTIME_MODES.includes((mode ?? "").trim().toLowerCase());
}

function explicitIosApiBase(env) {
  return (
    env.VITE_ELIZA_IOS_API_BASE ??
    env.VITE_ELIZA_MOBILE_API_BASE ??
    ""
  ).trim();
}

/**
 * The #11030 rule for the ios-local (dev/sideload) lane: the renderer it
 * bakes must carry `runtimeMode=local` — a cloud-mode bundle with no
 * configured agent endpoint hangs at "Booting up…" on a physical device (the
 * native AgentPlugin returns `state:"error"` — "iOS Agent requires a
 * configured HTTP endpoint for remote/cloud mode, or runtimeMode=local for
 * dev/sideload local mode").
 *
 * `runtimeMode` is either the mode this lane WILL bake
 * (`resolveExpectedRendererStamp(...).runtimeMode` — a non-local value can
 * only reach the lane through a leaked `VITE_ELIZA_IOS_RUNTIME_MODE`
 * override; the lane defaults to `local`) or the mode an EXISTING dist
 * manifest carries when that dist is about to be staged. Either way a
 * non-local mode is allowed ONLY when an agent endpoint is explicitly
 * configured (`VITE_ELIZA_IOS_API_BASE` / `VITE_ELIZA_MOBILE_API_BASE`) —
 * an intentional cloud sideload.
 *
 * @param {{ platform: string,
 *           runtimeMode: string|null,
 *           env?: Record<string, string|undefined> }} opts
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateIosLocalLaneRuntime({
  platform,
  runtimeMode,
  env = {},
}) {
  if (platform !== "ios-local") {
    return { ok: true, reason: `lane '${platform}' has no local-runtime rule` };
  }
  if (isLocalAgentRuntimeMode(runtimeMode)) {
    return { ok: true, reason: `lane bakes runtimeMode=${runtimeMode}` };
  }
  const apiBase = explicitIosApiBase(env);
  if (apiBase) {
    return {
      ok: true,
      reason: `cloud-mode sideload with an explicit Agent.apiBase (${apiBase})`,
    };
  }
  return {
    ok: false,
    reason:
      `the ios-local lane bakes runtimeMode=${describeStampValue(runtimeMode)} with no Agent.apiBase — ` +
      `on a device the native agent errors out and the app hangs at "Booting up…" (issue #11030). ` +
      `Unset VITE_ELIZA_IOS_RUNTIME_MODE (this lane defaults to local), or set ` +
      `VITE_ELIZA_IOS_API_BASE to a reachable agent endpoint for an intentional cloud sideload.`,
  };
}

/**
 * B3 preflight rule (#11030): is the bundle STAGED into the native iOS
 * project safe to sideload onto a device?
 *
 * A sideloaded bundle must either configure an explicit agent endpoint
 * (`Agent.apiBase` in the staged `capacitor.config.json`) or be local-mode on
 * BOTH staged halves: the native Agent plugin config (what
 * `AgentPlugin.swift` reads) AND the renderer build stamp
 * (`public/eliza-renderer-build.json`, what the web bundle baked). A cloud
 * half on either side without an endpoint is the exact broken combination
 * from issue #11030 — the native agent errors out / the renderer never uses
 * the local IPC transport, and the device hangs at "Booting up…".
 *
 * NOTE the store/sideload asymmetry: the App Store lane (`--store`)
 * legitimately ships a cloud-hybrid bundle with no `Agent.apiBase` — cloud
 * onboarding happens in-app after install. This rule therefore applies to
 * sideload preflight ONLY; never wire it into the store lane.
 *
 * @param {{ agentConfig: { runtimeMode?: string|null, apiBase?: string|null } | null,
 *           rendererManifest: { runtimeMode?: string|null } | null }} opts
 * @returns {{ ok: boolean, staged: boolean, reason: string }}
 */
export function evaluateStagedIosSideloadBundle({
  agentConfig,
  rendererManifest,
}) {
  if (!agentConfig && !rendererManifest) {
    return {
      ok: true,
      staged: false,
      reason:
        "no staged bundle to validate (run a build / cap sync first; the check re-runs post-build)",
    };
  }
  const apiBase = (agentConfig?.apiBase ?? "").trim();
  if (apiBase) {
    return {
      ok: true,
      staged: true,
      reason: `staged Agent.apiBase is configured (${apiBase})`,
    };
  }
  const stagedModes = [
    ["capacitor.config.json Agent.runtimeMode", agentConfig?.runtimeMode],
    ["renderer stamp runtimeMode", rendererManifest?.runtimeMode],
  ]
    .map(([label, value]) => [label, (value ?? "").trim()])
    .filter(([, value]) => value.length > 0);
  if (
    stagedModes.length > 0 &&
    stagedModes.every(([, value]) => isLocalAgentRuntimeMode(value))
  ) {
    return {
      ok: true,
      staged: true,
      reason: `staged bundle is local-mode (${stagedModes
        .map(([label, value]) => `${label}='${value}'`)
        .join(", ")})`,
    };
  }
  const found =
    stagedModes.length > 0
      ? stagedModes.map(([label, value]) => `${label}='${value}'`).join(", ")
      : "no runtime mode staged at all";
  return {
    ok: false,
    staged: true,
    reason:
      `staged bundle is cloud-mode (not local on every staged half) with no Agent.apiBase (${found}) — sideloaded to a device, ` +
      `the native agent errors out and the app hangs at "Booting up…" (issue #11030). ` +
      `Rebuild with \`bun run --cwd packages/app build:ios:local\` (local on-device agent), or set ` +
      `VITE_ELIZA_IOS_API_BASE to a reachable agent endpoint for an intentional cloud sideload.`,
  };
}
