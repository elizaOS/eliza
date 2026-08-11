/**
 * Pure mode-parsing and local-runtime state-seeding helpers for the iOS voice
 * self-test orchestrator (`ios-voice-selftest-smoke.mjs`). Kept dependency-free
 * so they are the single source of truth for "which host owns this run?" and
 * "what simulator defaults make the app boot into local runtime?" shared by the
 * smoke runner and its contract tests (`ios-voice-selftest-mode.test.mjs`).
 *
 * Background (#18313): the shipped voice lane always started a deterministic
 * remote host agent that does NOT register plugin-local-inference or an ASR/TTS
 * backend, so the in-app voice verifier reported `local-inference ASR not ready`
 * by construction — the lane could never turn green. This module adds an
 * explicit `local` mode that seeds the iOS simulator preferences for local
 * runtime (same convention as `mobile-local-chat-smoke --ios-select-local`) and
 * never arms the remote host or onboarding request, so the in-app voice
 * verifier drives the REAL on-device ASR/TTS pipeline.
 *
 * `remote` mode preserves the original behavior for remote-agent compatibility
 * lanes — but it is NOT the default, because a remote host that lacks
 * local-inference cannot satisfy the real ASR/TTS acceptance contract.
 */

/** The canonical IPC base for the iOS on-device local agent. */
export const IOS_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";

/** Valid runtime modes for the voice self-test orchestrator. */
export const VOICE_SELFTEST_MODES = /** @type {const} */ (["local", "remote"]);

/** The default mode — exercises the real on-device voice pipeline. */
export const DEFAULT_VOICE_SELFTEST_MODE = "local";

/**
 * The active-server preference value that makes the app boot into local
 * runtime. Matches `preseedIosLocalRuntime` in `mobile-local-chat-smoke.mjs`
 * and the `eliza-local-agent://ipc` convention shared by iOS/Android.
 *
 * @param {string} [label] Optional display label override.
 * @returns {string} JSON string for `elizaos:active-server`.
 */
export function localActiveServerJson(label = "On-device agent") {
  return JSON.stringify({
    id: "local:mobile",
    kind: "remote",
    label,
    apiBase: IOS_LOCAL_AGENT_IPC_BASE,
  });
}

/**
 * Parse the voice self-test mode from the argv of the orchestrator CLI. An
 * explicit `--mode <local|remote>` wins; `--local` / `--remote` convenience
 * flags also map; if none is given, the default (`local`) is returned. An
 * invalid value throws so a typo can never silently fall back to a mode that
 * cannot satisfy the acceptance contract.
 *
 * @param {string[]} argv The raw process.argv (or a test-supplied equivalent).
 * @param {{ default?: (typeof VOICE_SELFTEST_MODES)[number] }} [options]
 * @returns {(typeof VOICE_SELFTEST_MODES)[number]}
 */
export function parseVoiceSelfTestMode(
  argv,
  { default: defaultMode = DEFAULT_VOICE_SELFTEST_MODE } = {},
) {
  const explicitIndex = argv.indexOf("--mode");
  if (explicitIndex >= 0) {
    const value = argv[explicitIndex + 1];
    if (!value || !VOICE_SELFTEST_MODES.includes(/** @type {any} */ (value))) {
      throw new Error(
        `Invalid --mode "${value}". Expected one of: ${VOICE_SELFTEST_MODES.join(
          ", ",
        )}.`,
      );
    }
    return /** @type {(typeof VOICE_SELFTEST_MODES)[number]} */ (value);
  }
  if (argv.includes("--local")) return "local";
  if (argv.includes("--remote")) return "remote";
  return defaultMode;
}

/**
 * Decide whether the orchestrator should start the deterministic remote host
 * agent (`serve-real-local-agent.ts`). Only `remote` mode without an explicit
 * `--api-base` starts a host; `local` mode never does (the on-device agent
 * owns the pipeline), and a `remote` run with `--api-base` assumes the caller
 * brought their own reachable backend.
 *
 * @param {{ mode: (typeof VOICE_SELFTEST_MODES)[number], apiBase: string | null }} ctx
 * @returns {boolean}
 */
export function shouldStartRemoteHost({ mode, apiBase }) {
  if (mode === "local") return false;
  return !apiBase;
}

/**
 * Build the sequence of simulator-defaults writes that put the installed app
 * into local runtime before launch: `mobile-runtime-mode=local`,
 * `first-run-complete=1`, and the canonical `eliza-local-agent://ipc`
 * active-server record. This is the same triple `preseedIosLocalRuntime` writes
 * in `mobile-local-chat-smoke.mjs`; extracted here so the voice lane and its
 * contract test share one definition.
 *
 * In `remote` mode this returns an empty array — the remote onboarding request
 * (armed separately) drives first-run.
 *
 * @param {{ mode: (typeof VOICE_SELFTEST_MODES)[number] }} ctx
 * @returns {Array<{ key: string, value: string }>}
 */
export function localRuntimePreferenceWrites({ mode }) {
  if (mode !== "local") return [];
  return [
    { key: "eliza:mobile-runtime-mode", value: "local" },
    { key: "eliza:first-run-complete", value: "1" },
    { key: "elizaos:active-server", value: localActiveServerJson() },
  ];
}

/**
 * Build the JSON value to stage in the onboarding-smoke request preference. In
 * local mode this is `null` (no remote onboarding is armed); in remote mode it
 * carries the host apiBase so the in-app verifier connects to the remote host.
 *
 * @param {{ mode: (typeof VOICE_SELFTEST_MODES)[number], apiBase: string | null }} ctx
 * @returns {string | null} JSON string for the onboarding request, or null.
 */
export function onboardingRequestJson({ mode, apiBase }) {
  if (mode === "local") return null;
  return JSON.stringify({ apiBase });
}

/**
 * Build the JSON value to stage in the voice self-test request preference. In
 * local mode the request carries no apiBase (the app resolves the on-device
 * IPC agent); in remote mode it carries the host apiBase so the in-app
 * verifier points at the remote backend.
 *
 * @param {{ mode: (typeof VOICE_SELFTEST_MODES)[number], apiBase: string | null }} ctx
 * @returns {string}
 */
export function voiceRequestJson({ mode, apiBase }) {
  if (mode === "local") return JSON.stringify({});
  return JSON.stringify({ apiBase });
}
