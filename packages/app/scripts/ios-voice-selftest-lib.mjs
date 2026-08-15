/**
 * Pure verdict and poll-policy helpers for the iOS simulator voice round-trip
 * lane (`ios-voice-selftest-smoke.mjs`). Kept dependency-free so it is the
 * single source of truth for "did the REAL mic->ASR->agent->TTS loop pass?"
 * shared by the in-app WKWebView verifier (which mirrors this check to signal
 * early) and the host-side orchestrator (which re-derives the verdict from the
 * raw report as the authoritative hard gate), plus safe-integer parsing for
 * host poll knobs. Unit-tested by `ios-voice-selftest-lib.test.mjs`.
 *
 * The no-false-green contract matches `voice-selftest.android.spec.ts`: overall
 * must be `pass` AND each of the asr/send/tts stages must be `pass`. A `skipped`
 * stage (e.g. local-inference ASR not provisioned) is NOT a pass — it fails the
 * lane loudly so "can't run here" never reads as "verified working".
 *
 * Poll env overrides (`IOS_VOICE_SELFTEST_ATTEMPTS` / `_DELAY_MS`) must be
 * complete safe-integer decimals. Partial `Number.parseInt` forms cannot
 * silently shrink the budget (e.g. `"30junk"` → 30) before the host times out.
 */

/** The three stages every real voice round-trip must clear, in order. */
export const REQUIRED_VOICE_STAGES = ["asr", "send", "tts"];

/** Default host-side Preferences poll budget when env overrides are unset. */
export const DEFAULT_VOICE_SELFTEST_ATTEMPTS = 300;

/** Default delay between Preferences polls when env overrides are unset. */
export const DEFAULT_VOICE_SELFTEST_DELAY_MS = 1000;

/** Node clamps setTimeout delays above this value to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Accept only complete positive safe-integer decimal strings (or numbers).
 * Rejects partial numbers, signed values, fractions, and non-positive values.
 * @param {string | number} value
 * @param {string} label
 * @returns {number}
 */
export function parsePositiveSafeInteger(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `${label} must be a positive safe-integer decimal (received ${JSON.stringify(value)})`,
      );
    }
    return value;
  }
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${label} must be a positive safe-integer decimal (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(
      `${label} must be a positive safe-integer decimal (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  return parsed;
}

/**
 * Accept only complete non-negative safe-integer decimal strings (or numbers),
 * including zero. Same reject set as {@link parsePositiveSafeInteger} except 0.
 * An optional max enforces a runtime timer ceiling.
 * @param {string | number} value
 * @param {string} label
 * @param {{ max?: number }} [options]
 * @returns {number}
 */
export function parseNonNegativeSafeInteger(value, label, options = {}) {
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const requirement =
    max === Number.MAX_SAFE_INTEGER
      ? "a non-negative safe-integer decimal"
      : `a non-negative safe-integer decimal no greater than ${max}`;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) {
      throw new Error(
        `${label} must be ${requirement} (received ${JSON.stringify(value)})`,
      );
    }
    return value;
  }
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${label} must be ${requirement} (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > max ||
    String(parsed) !== raw
  ) {
    throw new Error(
      `${label} must be ${requirement} (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  return parsed;
}

function isUnsetEnv(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

/**
 * Resolve host-side Preferences poll policy from env. Unset/empty overrides
 * keep the historical defaults (300 attempts / 1000 ms). Any other explicit
 * value must be a complete safe-integer decimal or the lane fails closed
 * before simulator boot or host-agent spawn.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ attempts: number, delayMs: number }}
 */
export function resolveVoiceSelfTestPollPolicy({ env = process.env } = {}) {
  const attempts = isUnsetEnv(env.IOS_VOICE_SELFTEST_ATTEMPTS)
    ? DEFAULT_VOICE_SELFTEST_ATTEMPTS
    : parsePositiveSafeInteger(
        String(env.IOS_VOICE_SELFTEST_ATTEMPTS),
        "IOS_VOICE_SELFTEST_ATTEMPTS",
      );
  const delayMs = isUnsetEnv(env.IOS_VOICE_SELFTEST_DELAY_MS)
    ? DEFAULT_VOICE_SELFTEST_DELAY_MS
    : parseNonNegativeSafeInteger(
        String(env.IOS_VOICE_SELFTEST_DELAY_MS),
        "IOS_VOICE_SELFTEST_DELAY_MS",
        { max: MAX_TIMER_DELAY_MS },
      );
  return { attempts, delayMs };
}

/**
 * Reduce a {@link VoiceSelfTestReport}-shaped object to a hard pass/fail verdict
 * with human-readable reasons for every failing check. Returns `pass:false`
 * (never throws) for a missing/corrupt report so the caller can surface the raw
 * payload; the orchestrator turns `pass:false` into a nonzero exit.
 *
 * @param {unknown} report Parsed voice self-test report (or null/garbage).
 * @returns {{ pass: boolean, reasons: string[], stageStatuses: Record<string,string>, transcript: string, reply: string, overall: string }}
 */
export function evaluateVoiceSelfTestReport(report) {
  const reasons = [];
  if (!report || typeof report !== "object") {
    return {
      pass: false,
      reasons: ["report is missing or not an object"],
      stageStatuses: {},
      transcript: "",
      reply: "",
      overall: "unknown",
    };
  }

  const overall =
    typeof report.overall === "string" ? report.overall : "unknown";
  const transcript =
    typeof report.transcript === "string" ? report.transcript : "";
  const reply = typeof report.reply === "string" ? report.reply : "";
  const stages = Array.isArray(report.stages) ? report.stages : [];

  const stageStatuses = {};
  for (const stage of stages) {
    if (stage && typeof stage.stage === "string") {
      stageStatuses[stage.stage] =
        typeof stage.status === "string" ? stage.status : "unknown";
    }
  }

  if (overall !== "pass") {
    reasons.push(`overall is "${overall}", expected "pass"`);
  }

  for (const name of REQUIRED_VOICE_STAGES) {
    const status = stageStatuses[name];
    if (status === undefined) {
      reasons.push(`stage "${name}" is missing from the report`);
    } else if (status !== "pass") {
      // A skipped stage fails just like a failed one — parity with the Android
      // spec's no-false-green rule.
      reasons.push(`stage "${name}" is "${status}", expected "pass"`);
    }
  }

  // The fixture says "what time is it"; a real transcript must contain "time",
  // and a real agent turn must produce a non-empty reply.
  if (!transcript.toLowerCase().includes("time")) {
    reasons.push(
      `transcript ${JSON.stringify(transcript)} does not contain "time"`,
    );
  }
  if (reply.trim().length === 0) {
    reasons.push("agent reply is empty");
  }

  return {
    pass: reasons.length === 0,
    reasons,
    stageStatuses,
    transcript,
    reply,
    overall,
  };
}
