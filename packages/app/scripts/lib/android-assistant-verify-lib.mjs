/**
 * Pure parsers for the Android assistant-role / voice-IME / assist-key
 * verification lane (issue #13581). Every function here takes the raw stdout of
 * an `adb`/`cmd`/`dumpsys`/`logcat` invocation and returns a typed decision
 * object — no process spawning, no I/O, no device. The orchestrator
 * (`android-assistant-verify.mjs`) owns the adb calls and feeds their output
 * here; keeping the string→decision logic in this file is what lets the whole
 * verification lane be unit-tested with `node --test` on a host with no device
 * attached (the parsers are the part that regresses silently, so they are the
 * part that must be covered off-device).
 *
 * Naming/constants mirror the native surfaces under
 * `packages/app-core/platforms/android/app/src/main/`:
 *   - {@link ASSISTANT_VIS_COMPONENT} — ElizaVoiceInteractionService (ROLE_ASSISTANT).
 *   - {@link ASSISTANT_IME_COMPONENT} — ElizaVoiceInputMethodService (voice IME).
 *   - deep-link source tags — the exact `source=` params the native entry
 *     points stamp so a logcat/`dumpsys activity` scrape can prove which surface
 *     drove the app (ElizaVoiceInteractionSession / ElizaVoiceInputMethodService /
 *     ElizaAssistActivity).
 */

export const APP_PACKAGE = "ai.elizaos.app";

/** VoiceInteractionService that surfaces Eliza as the digital-assistant (ROLE_ASSISTANT) candidate. */
export const ASSISTANT_VIS_COMPONENT = `${APP_PACKAGE}/.ElizaVoiceInteractionService`;
/** Paired session service the framework requires alongside the VIS. */
export const ASSISTANT_SESSION_COMPONENT = `${APP_PACKAGE}/.ElizaVoiceInteractionSessionService`;
/** Paired recognition service the framework requires alongside the VIS. */
export const ASSISTANT_RECOGNITION_COMPONENT = `${APP_PACKAGE}/.ElizaRecognitionService`;
/** Voice-input keyboard (IME) that surfaces under Languages & input. */
export const ASSISTANT_IME_COMPONENT = `${APP_PACKAGE}/.ElizaVoiceInputMethodService`;
/** ACTION_ASSIST / ACTION_VOICE_COMMAND fallback activity. */
export const ASSIST_ACTIVITY_COMPONENT = `${APP_PACKAGE}/.ElizaAssistActivity`;
/** The single entry activity every deep-link lands in. */
export const MAIN_ACTIVITY_COMPONENT = `${APP_PACKAGE}/.MainActivity`;

export const ROLE_ASSISTANT = "android.app.role.ASSISTANT";

/**
 * Deep-link source tags stamped by each native entry point. The value is the
 * `source=` query param in the `elizaos://…` URI the surface hands to
 * MainActivity; asserting the tag lands in `dumpsys activity`/logcat is how the
 * lane proves the invocation reached the Eliza entry point rather than any other
 * assistant. Keep in exact sync with the Java sources.
 */
export const DEEP_LINK_SOURCES = Object.freeze({
  assistantSession: "android-assistant-session",
  ime: "android-ime",
  assist: "android-assist",
  voiceCommand: "android-voice-command",
});

/** logcat source tags each native surface logs under (Log.i(TAG, …)). */
export const LOG_TAGS = Object.freeze({
  vis: "ElizaVoiceInteraction",
  ime: "ElizaVoiceIme",
});

const COMPONENT_ID_RE = /^[A-Za-z0-9_.]+\/\.?[A-Za-z0-9_$.]+$/;

/**
 * Normalize a component id to `pkg/pkg.Class` fully-qualified form. `dumpsys`
 * variously prints `pkg/.Class` (short) and `pkg/pkg.Class` (full); the two must
 * compare equal. Throws on a shape that isn't a component id so a garbled scrape
 * can never silently "match nothing" and read as absence.
 */
export function normalizeComponent(componentId) {
  if (
    typeof componentId !== "string" ||
    !COMPONENT_ID_RE.test(componentId.trim())
  ) {
    throw new Error(`Not a component id: ${JSON.stringify(componentId)}`);
  }
  const [pkg, cls] = componentId.trim().split("/");
  const fqcn = cls.startsWith(".") ? `${pkg}${cls}` : cls;
  return `${pkg}/${fqcn}`;
}

/**
 * Whether `haystack` contains the given component in either its full
 * (`pkg/pkg.Class`) or short (`pkg/.Class`) form. The match requires a right
 * BOUNDARY — the component id must not be a prefix of a longer class token — so
 * a renamed surface (e.g. `…ElizaVoiceInteractionServiceRENAMED`) reads as
 * ABSENT rather than falsely matching `…ElizaVoiceInteractionService`. That is
 * exactly the regression the lane exists to catch, so the matcher must not
 * paper over it. Java class chars are `[A-Za-z0-9_$.]`; the boundary is any
 * character outside that set (or end of string).
 */
function componentMatches(haystack, componentId) {
  const full = normalizeComponent(componentId);
  const [pkg, fqcn] = full.split("/");
  const shortCls = fqcn.startsWith(pkg) ? fqcn.slice(pkg.length) : `.${fqcn}`;
  const short = `${pkg}/${shortCls}`;
  const boundary = "(?![A-Za-z0-9_$.])";
  return (
    new RegExp(escapeRe(full) + boundary).test(haystack) ||
    new RegExp(escapeRe(short) + boundary).test(haystack)
  );
}

/**
 * Parse `dumpsys package <pkg>` (or the `Service Resolver Table` section of a
 * bare `dumpsys package`) for whether a given service component is registered
 * for an intent action. Registration is what makes the surface a *candidate*
 * (assistant / IME) at all; a missing entry means the manifest declaration
 * failed to parse (e.g. VoiceInteractionServiceInfo rejected the VIS for a
 * missing recognitionService), which the lane must catch as a hard failure —
 * not skip.
 *
 * @returns {{ registered: boolean, actionSeen: boolean }}
 */
export function parseServiceRegistration(
  dumpsysOutput,
  componentId,
  intentAction,
) {
  const text = String(dumpsysOutput ?? "");
  const registered = componentMatches(text, componentId);
  const actionSeen = intentAction ? text.includes(intentAction) : true;
  return { registered, actionSeen };
}

/**
 * Parse `dumpsys package <pkg>` for the manifest-declared assistant + IME
 * surfaces in one pass. Returns a per-component boolean map plus an `allPresent`
 * summary so the caller asserts every surface the manifest declares actually
 * survived install-time parsing.
 */
export function parseAssistantSurfaces(dumpsysPackageOutput) {
  const text = String(dumpsysPackageOutput ?? "");
  const components = {
    voiceInteractionService: ASSISTANT_VIS_COMPONENT,
    voiceInteractionSessionService: ASSISTANT_SESSION_COMPONENT,
    recognitionService: ASSISTANT_RECOGNITION_COMPONENT,
    inputMethodService: ASSISTANT_IME_COMPONENT,
    assistActivity: ASSIST_ACTIVITY_COMPONENT,
  };
  const present = {};
  for (const [key, componentId] of Object.entries(components)) {
    present[key] = componentMatches(text, componentId);
  }
  return {
    present,
    allPresent: Object.values(present).every(Boolean),
    missing: Object.entries(present)
      .filter(([, ok]) => !ok)
      .map(([key]) => key),
  };
}

/**
 * Parse `cmd role holders android.app.role.ASSISTANT` output for whether our
 * package holds the assistant role. The command prints one holder package per
 * line (empty when no holder). A held role is the precondition for the assist
 * gesture / assist-key routing to Eliza's VIS session.
 */
export function parseRoleHolders(cmdRoleOutput, expectedPackage = APP_PACKAGE) {
  const holders = String(cmdRoleOutput ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line.length > 0 && !/^Exception|^Error|^usage:/i.test(line),
    );
  return {
    holders,
    heldByExpected: holders.includes(expectedPackage),
  };
}

/**
 * Parse `dumpsys voiceinteraction` (or a `settings get secure
 * voice_interaction_service`) for the currently-selected assistant component,
 * and decide whether it is ours. The lane fires `cmd voiceinteraction show`
 * only when this resolves to the Eliza VIS — otherwise the invocation would
 * drive whatever *other* assistant is selected and prove nothing.
 *
 * `dumpsys voiceinteraction` prints a line like:
 *   mCurInteractor=ComponentInfo{ai.elizaos.app/ai.elizaos.app.ElizaVoiceInteractionService}
 * and `settings get secure voice_interaction_service` prints the flattened
 * `pkg/cls`. Both shapes are accepted.
 */
export function parseVoiceInteractionService(output) {
  const text = String(output ?? "");
  const componentInfo = text.match(/ComponentInfo\{([^}]+)\}/);
  const flattened = text.match(/([A-Za-z0-9_.]+\/[A-Za-z0-9_$.]+)/);
  const selected = (componentInfo?.[1] ?? flattened?.[1] ?? "").trim();
  return {
    selected: selected || null,
    isEliza: selected
      ? componentMatches(selected, ASSISTANT_VIS_COMPONENT)
      : false,
  };
}

/**
 * Parse `settings get secure default_input_method` (a flattened component) for
 * whether the Eliza voice IME is the selected keyboard. Selecting the IME is
 * what makes a mic long-press hand off to Eliza; the lane must re-apply and
 * re-assert this after every reinstall because `adb install -r` clears it.
 */
export function parseDefaultInputMethod(settingsOutput) {
  const selected =
    String(settingsOutput ?? "")
      .trim()
      .split(/\s+/)[0] ?? "";
  return {
    selected: selected && selected !== "null" ? selected : null,
    isEliza: selected
      ? componentMatches(selected, ASSISTANT_IME_COMPONENT)
      : false,
  };
}

/**
 * Parse `ime list -s` (short form: one enabled IME id per line) for whether the
 * Eliza IME is in the *enabled* set. Enabling is separate from selecting — an
 * IME must be enabled before `ime set` can select it — so the lane asserts both.
 */
export function parseEnabledImes(imeListOutput) {
  const enabled = String(imeListOutput ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => COMPONENT_ID_RE.test(line));
  return {
    enabled,
    elizaEnabled: enabled.some((id) =>
      componentMatches(id, ASSISTANT_IME_COMPONENT),
    ),
  };
}

/**
 * Scan a logcat buffer for the source tag of a given native surface, proving the
 * invocation actually reached the Eliza entry point. Matches either the
 * bracketed class marker the surfaces log (`[ElizaVoiceInputMethodService] …`)
 * or the deep-link `source=<tag>` param, so it works whether we scrape the
 * service's own logs or the ActivityManager's intent log.
 *
 * @param {string} logcatOutput raw `adb logcat -d` buffer
 * @param {{ tag?: string, source?: string }} probe class TAG and/or deep-link source
 */
export function detectSurfaceInvocation(logcatOutput, probe) {
  const text = String(logcatOutput ?? "");
  const tagHit = probe?.tag
    ? new RegExp(`\\b${escapeRe(probe.tag)}\\b`).test(text)
    : false;
  const bracketHit = probe?.bracket
    ? text.includes(`[${probe.bracket}]`)
    : false;
  const sourceHit = probe?.source
    ? text.includes(`source=${probe.source}`)
    : false;
  return {
    tagHit,
    bracketHit,
    sourceHit,
    detected: tagHit || bracketHit || sourceHit,
  };
}

/**
 * Decide whether an assist/IME deep-link landed in MainActivity. Accepts a
 * combined blob of `dumpsys activity activities` (top of the resumed stack) plus
 * the same-run logcat, and asserts BOTH that MainActivity is resumed AND that
 * the expected deep-link source tag appears — so a coincidental foreground
 * MainActivity from an unrelated launch can't pass.
 *
 * @param {string} activityDump `dumpsys activity activities` / `top-activity` output
 * @param {string} logcatOutput same-run logcat buffer
 * @param {string} expectedSource one of DEEP_LINK_SOURCES
 */
export function assertDeepLinkLanded(
  activityDump,
  logcatOutput,
  expectedSource,
) {
  const dump = String(activityDump ?? "");
  const mainActivityResumed =
    /ResumedActivity[:\s].*ai\.elizaos\.app\/[.A-Za-z0-9_]*MainActivity/.test(
      dump,
    ) ||
    /mResumedActivity[:\s].*ai\.elizaos\.app\/[.A-Za-z0-9_]*MainActivity/.test(
      dump,
    ) ||
    /topResumedActivity[:\s].*ai\.elizaos\.app\/[.A-Za-z0-9_]*MainActivity/.test(
      dump,
    ) ||
    componentMatches(dump, MAIN_ACTIVITY_COMPONENT);
  const sourceInLog = String(logcatOutput ?? "").includes(
    `source=${expectedSource}`,
  );
  const sourceInDump = dump.includes(`source=${expectedSource}`);
  return {
    mainActivityResumed,
    sourceSeen: sourceInLog || sourceInDump,
    landed: mainActivityResumed && (sourceInLog || sourceInDump),
    expectedSource,
  };
}

/**
 * Classify the IME ASR round-trip outcome from the IME's own logcat lines. The
 * engine may legitimately be off (loopback refused) — that is the designed
 * ENGINE_OFF state, not a failure — so this distinguishes the three real
 * outcomes the native code produces rather than collapsing them:
 *   - committed: "transcript committed (N chars)"
 *   - engineOff: "ASR loopback unreachable"
 *   - modelNotReady: "ASR responded 503"
 * The caller decides which outcomes are acceptable given whether a full engine
 * is expected (ELIZA_ANDROID_REQUIRE_AGENT-style gating).
 */
export function classifyImeAsrOutcome(logcatOutput) {
  const text = String(logcatOutput ?? "");
  if (/transcript committed \(\d+ chars\)/.test(text)) return "committed";
  if (/ASR loopback unreachable/.test(text)) return "engineOff";
  if (
    /ASR responded 503/.test(text) ||
    /model_not_ready|MODEL_NOT_READY/.test(text)
  ) {
    return "modelNotReady";
  }
  if (/transcription error|error_transcribe/.test(text)) return "error";
  return "unknown";
}

/**
 * Roll the individual scrape results into one lane verdict. Fails the lane if
 * any required surface is missing/misrouted. The surface/routing checks always
 * gate; the ASR-outcome checks are conditioned on whether a full engine is
 * required, because the verify lane only drives the deep-link entry points — it
 * never raises the IME keyboard or captures audio, so the mic→transcribe round
 * trip is exercised only on a full-engine build/device, never on the engine-less
 * emulator lane.
 *
 * ASR-outcome gating:
 *   - `error` always fails: the native code hit a transcription exception, which
 *     is a real defect regardless of whether an engine was expected.
 *   - `engineOff`/`unknown` fail ONLY when `requireAgent` is set. An honest
 *     ENGINE_OFF (loopback refused) is the designed state when no engine is
 *     staged; `unknown` is the "the round-trip was never driven" state the
 *     emulator lane legitimately produces (the deep-link path logs no ASR line).
 *     When a full engine IS required, neither is acceptable — the lane must see a
 *     committed transcript (or the model-not-ready shape), so both fail loud.
 *
 * @param {object} results
 * @param {boolean} results.surfacesRegistered
 * @param {boolean} results.roleHeld
 * @param {boolean} results.imeSelected
 * @param {boolean} results.voiceinteractionLanded
 * @param {boolean} results.assistKeyLanded
 * @param {boolean} results.imeLanded
 * @param {string}  results.asrOutcome  from classifyImeAsrOutcome
 * @param {boolean} requireAgent        when true, engine must be up (committed/modelNotReady only)
 */
export function summarizeLaneVerdict(results, requireAgent) {
  const failures = [];
  if (!results.surfacesRegistered)
    failures.push("assistant/IME surfaces not registered");
  if (!results.roleHeld) failures.push("assistant role not held by Eliza");
  if (!results.imeSelected) failures.push("Eliza IME not selected");
  if (!results.voiceinteractionLanded)
    failures.push("cmd voiceinteraction show did not reach MainActivity");
  if (!results.assistKeyLanded)
    failures.push("KEYCODE_ASSIST did not reach MainActivity");
  if (!results.imeLanded)
    failures.push("IME invocation did not reach MainActivity");
  if (results.asrOutcome === "error")
    failures.push("IME ASR round-trip errored");
  if (requireAgent && results.asrOutcome === "engineOff") {
    failures.push(
      "full engine required but ASR loopback was unreachable (ENGINE_OFF)",
    );
  }
  if (requireAgent && results.asrOutcome === "unknown") {
    failures.push(
      "full engine required but IME ASR outcome was unknown (no committed transcript)",
    );
  }
  return { pass: failures.length === 0, failures };
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
