/**
 * Mobile build-lane pollution guard (issue #11030).
 *
 * `build:ios:local` must be deterministic: it bakes `runtimeMode=local` into
 * the renderer and compiles the local native runtime. A previous
 * `install:ios:cloud:sideload --cloud` run (or a lingering
 * `VITE_ELIZA_IOS_RUNTIME_MODE` / `ELIZA_BUILD_VARIANT` export or `.env`
 * entry — `bun run` auto-loads `.env`) used to silently poison later local
 * builds: the store/cloud-hybrid web bundle stayed in `dist/` and the synced
 * Xcode `public/`, every later device build baked it, and the phone hung on
 * "Booting up…" forever with no configured Agent.apiBase.
 *
 * These helpers are pure so the guard logic is unit-testable:
 *   - `expectedRendererRuntimeMode(policy, env)` mirrors exactly how
 *     `buildWeb()` resolves the runtime mode it passes to Vite (env override
 *     wins over the lane policy), which is also what the
 *     `renderer-build-manifest` plugin stamps into
 *     `dist/eliza-renderer-build.json`.
 *   - `iosLaneRuntimeModeProblem()` hard-fails an `ios-local` invocation whose
 *     resolved runtime mode is not `local` (the exact pollution class that
 *     bricked real-device boots).
 *   - `stagedRendererLaneProblems()` asserts the manifest staged into the
 *     Xcode project matches THIS invocation's lane, so a stale cloud sync can
 *     never ship inside a local build.
 */

const LANE_MISMATCH_ESCAPE_ENV = "ELIZA_IOS_ALLOW_LANE_RUNTIME_MISMATCH";

function trimmedEnvValue(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the renderer runtime mode a `buildWeb()` invocation will bake,
 * mirroring the env spread in `run-mobile-build.mjs` exactly: for iOS lanes a
 * pre-set `VITE_ELIZA_IOS_RUNTIME_MODE` deliberately wins over the lane
 * policy; for Android lanes the policy value is passed unconditionally. This
 * is also what the `renderer-build-manifest` Vite plugin stamps into
 * `dist/eliza-renderer-build.json`.
 *
 * @param {{ iosRuntimeMode?: string|null, androidRuntimeMode?: string|null }} policy
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function expectedRendererRuntimeMode(policy, env = process.env) {
  if (policy?.iosRuntimeMode) {
    return (
      trimmedEnvValue(env.VITE_ELIZA_IOS_RUNTIME_MODE) ?? policy.iosRuntimeMode
    );
  }
  if (policy?.androidRuntimeMode) {
    return policy.androidRuntimeMode;
  }
  return trimmedEnvValue(env.ELIZA_RUNTIME_MODE);
}

/**
 * The `ios-local` lane exists to produce a build whose renderer AND native
 * runtime are local. Any other resolved runtime mode means the invocation is
 * polluted (lingering `--cloud` env, a `.env` entry, or an exported
 * `VITE_ELIZA_IOS_RUNTIME_MODE`) and the resulting device build would hang on
 * "Booting up…" (#11030). Returns a human-readable problem string, or null
 * when the lane is clean. `ELIZA_IOS_ALLOW_LANE_RUNTIME_MISMATCH=1` is the
 * explicit escape hatch.
 *
 * @param {{ lane: "ios"|"ios-local", resolvedRuntimeMode: string|null, env?: NodeJS.ProcessEnv }} options
 * @returns {string|null}
 */
export function iosLaneRuntimeModeProblem({
  lane,
  resolvedRuntimeMode,
  env = process.env,
}) {
  if (lane !== "ios-local") return null;
  if (resolvedRuntimeMode === "local") return null;
  if (trimmedEnvValue(env[LANE_MISMATCH_ESCAPE_ENV]) === "1") return null;
  return (
    `[mobile-build] ios-local lane refused: resolved renderer runtime mode is ` +
    `'${resolvedRuntimeMode ?? "unset"}' but this lane bakes 'local'. ` +
    `A lingering cloud build setting is polluting this invocation — commonly a ` +
    `VITE_ELIZA_IOS_RUNTIME_MODE / ELIZA_IOS_RUNTIME_MODE export left over from ` +
    `an earlier 'install:ios:cloud:sideload --cloud' / 'build:ios:cloud:*' run, ` +
    `or a .env entry ('bun run' auto-loads .env). Unset it and rebuild, use the ` +
    `build:ios / build:ios:cloud:* lanes for cloud builds, or set ` +
    `${LANE_MISMATCH_ESCAPE_ENV}=1 to override (NOT recommended).`
  );
}

/**
 * Compare the renderer manifest staged into the native project against the
 * variant/runtimeMode/target THIS build invocation resolved. Any mismatch
 * means a previous sync (e.g. a `--cloud` sideload) staged a foreign bundle
 * and the native build would bake it. Returns a list of problems (empty when
 * conformant).
 *
 * @param {{
 *   manifest: { variant?: string|null, runtimeMode?: string|null, capacitorTarget?: string|null } | null,
 *   expectedVariant: string,
 *   expectedRuntimeMode: string|null,
 *   expectedTarget: string,
 * }} options
 * @returns {string[]}
 */
export function stagedRendererLaneProblems({
  manifest,
  expectedVariant,
  expectedRuntimeMode,
  expectedTarget,
}) {
  if (!manifest) {
    return [
      "staged renderer has no build manifest — cannot verify which lane produced it",
    ];
  }
  const problems = [];
  if (manifest.variant !== expectedVariant) {
    problems.push(
      `staged renderer variant is '${manifest.variant ?? "unset"}' but this lane builds '${expectedVariant}'`,
    );
  }
  if (
    expectedRuntimeMode != null &&
    manifest.runtimeMode !== expectedRuntimeMode
  ) {
    problems.push(
      `staged renderer runtimeMode is '${manifest.runtimeMode ?? "unset"}' but this lane builds '${expectedRuntimeMode}'`,
    );
  }
  if (manifest.capacitorTarget !== expectedTarget) {
    problems.push(
      `staged renderer capacitor target is '${manifest.capacitorTarget ?? "unset"}' but this lane builds '${expectedTarget}'`,
    );
  }
  return problems;
}

export function formatStagedRendererLaneError(lane, problems) {
  return (
    `[mobile-build] ${lane}: the staged renderer does not match this build lane:\n` +
    problems.map((problem) => `  - ${problem}`).join("\n") +
    `\nA previous Capacitor sync (e.g. 'install:ios:cloud:sideload --cloud') staged a ` +
    `foreign bundle, or lingering ELIZA_BUILD_VARIANT / VITE_ELIZA_IOS_RUNTIME_MODE env ` +
    `is steering this build. Re-run the lane in a clean environment so it re-syncs the ` +
    `correct bundle (issue #11030).`
  );
}
