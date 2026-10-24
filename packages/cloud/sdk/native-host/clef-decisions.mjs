/**
 * Clef decisions: small typed judgments from Cloudflare's Clef decision model
 * through Eliza Cloud, so no client holds a Workers AI key.
 *
 * This file is the one implementation. It has no dependencies, so a device
 * host that stages only `.mjs` files can import it. `src/clef-decisions.ts`
 * re-exports it, and `clef-decisions.d.mts` holds its types; each export
 * below is annotated with its declared type so `tsc -p native-host` checks
 * this file against them.
 *
 * Clef does not write text. It returns a probability for each answer the
 * caller allows, which makes it fast (tens of milliseconds for clef-flash)
 * and its confidence meaningful:
 *
 * - `choice`: which of a few page controls fits the person's goal, or none.
 * - `mode`: whether an action should stop and ask (`ask`) or be narrated and
 *   done (`tell`). This is a suggestion only. A deterministic safety floor
 *   always wins; use {@link combineActionMode}, which can raise but never
 *   lower the floor.
 * - `turn`: whether a spoken turn is finished, for natural turn-taking.
 *
 * Cloud answers HTTP 503 `{ status: "unavailable" }` when Clef is turned off
 * or failed. Callers must then keep their own rule (the floor, a local
 * heuristic such as {@link turnLooksComplete}) and never treat it as a yes.
 * Request text is not stored or logged by Cloud. Never send secret values
 * (passwords, codes, card or account numbers).
 */

/** @import * as Types from "./clef-decisions.mjs" */

/** @type {typeof Types.CLEF_DECISIONS_PATH} */
export const CLEF_DECISIONS_PATH = "/api/v1/decisions";

/**
 * Request limits. Larger requests are rejected, never truncated.
 * @type {typeof Types.CLEF_DECISION_LIMITS}
 */
export const CLEF_DECISION_LIMITS = Object.freeze({
  goal: 2_000,
  page: 16_000,
  candidates: 16,
  candidateId: 64,
  candidateLabel: 300,
  action: 1_000,
  context: 4_000,
  transcript: 2_000,
  recentTurns: 6,
});

/**
 * Option id Cloud adds to every choice: no candidate fits the goal.
 * @type {typeof Types.CLEF_NO_CHOICE}
 */
export const CLEF_NO_CHOICE = "none";

/**
 * `ask` from Clef at this probability or above: a doubtful action asks.
 * @type {typeof Types.CLEF_ASK_THRESHOLD}
 */
export const CLEF_ASK_THRESHOLD = 0.3;
/**
 * A turn is complete at this probability or above.
 * @type {typeof Types.CLEF_TURN_COMPLETE_THRESHOLD}
 */
export const CLEF_TURN_COMPLETE_THRESHOLD = 0.5;

/**
 * The mode to use: the floor's `ask` always stands; a suggestion can only
 * raise `tell` to `ask`. A missing suggestion keeps the floor.
 * @type {typeof Types.combineActionMode}
 */
export function combineActionMode(floor, suggestion) {
  return floor === "ask" || suggestion === "ask" ? "ask" : "tell";
}

const TRAILING_INCOMPLETE =
  /(?:^|\s)(?:and|or|but|so|um+|uh+|er+|like|because|the|a|an|to|of|my|your|for|with|then|point)$/i;
/** "$", "1,", "84 point": a number the person has not finished saying. */
const UNFINISHED_NUMBER = /(?:\$|\d,)$/;

/**
 * Offline fallback for `turn`: a turn that trails off ("and", "um", "so"),
 * ends on a connecting word or an unfinished number is not complete.
 * @type {typeof Types.turnLooksComplete}
 */
export function turnLooksComplete(transcript) {
  const raw = transcript.trim();
  if (!raw || /(?:\.\.\.|…|-|–|—)$/u.test(raw) || UNFINISHED_NUMBER.test(raw))
    return false;
  const text = raw.replace(/[\s,;:.!?]+$/u, "");
  return text.length > 0 && !TRAILING_INCOMPLETE.test(text);
}

/**
 * Request checks shared by Cloud and clients; returns a reason or null.
 * @type {typeof Types.clefDecisionRequestProblem}
 */
export function clefDecisionRequestProblem(request) {
  const limits = CLEF_DECISION_LIMITS;
  /** @type {(value: unknown, max: number) => boolean} */
  const text = (value, max) =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max;
  switch (request.kind) {
    case "choice": {
      if (!text(request.goal, limits.goal)) return "goal";
      if (request.page !== undefined && !text(request.page, limits.page))
        return "page";
      const candidates = request.candidates;
      if (
        !Array.isArray(candidates) ||
        candidates.length < 1 ||
        candidates.length > limits.candidates
      )
        return "candidates";
      const ids = new Set();
      for (const candidate of candidates) {
        if (
          !text(candidate?.id, limits.candidateId) ||
          !/^[A-Za-z0-9_.-]+$/.test(candidate.id) ||
          candidate.id === CLEF_NO_CHOICE ||
          ids.has(candidate.id) ||
          !text(candidate.label, limits.candidateLabel)
        )
          return "candidates";
        ids.add(candidate.id);
      }
      return null;
    }
    case "mode":
      if (!text(request.action, limits.action)) return "action";
      if (
        request.context !== undefined &&
        !text(request.context, limits.context)
      )
        return "context";
      return null;
    case "turn": {
      if (!text(request.transcript, limits.transcript)) return "transcript";
      const turns = request.recentTurns ?? [];
      if (!Array.isArray(turns) || turns.length > limits.recentTurns)
        return "recentTurns";
      for (const turn of turns) {
        if (
          (turn?.speaker !== "person" && turn?.speaker !== "assistant") ||
          !text(turn.text, limits.transcript)
        )
          return "recentTurns";
      }
      return null;
    }
    default:
      return "kind";
  }
}

/**
 * A body that is not JSON is a provider error, like a wrong one.
 * @param {string} text
 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // error-policy:J2 a body that is not JSON is the documented unavailable answer.
    return null;
  }
}

/**
 * Bounds header acquisition and body reads too, including host transports
 * that do not honor the fetch signal themselves. Late headers never dispatch.
 * @template T
 * @param {() => T | Promise<T>} operation
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
async function withAbort(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return operation();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Calls the Cloud route. Network and server failures, and a request past
 * `timeoutMs`, become `unavailable`. `onUnavailable` receives the HTTP status,
 * or null when no usable response came, so a caller can back off.
 * @type {typeof Types.createClefDecisionsClient}
 */
export function createClefDecisionsClient(options) {
  const send = options.fetch ?? fetch;
  const { timeoutMs, onUnavailable } = options;
  /** @type {(status: number | null, reason: "disabled" | "provider_error") => Types.ClefDecisionResponse} */
  const unavailable = (status, reason) => {
    onUnavailable?.(status);
    return { status: "unavailable", reason };
  };
  return async (request, signal) => {
    const problem = clefDecisionRequestProblem(request);
    if (problem)
      throw new TypeError(`Invalid Clef decision request: ${problem}`);
    const deadline =
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const combined =
      signal && deadline
        ? AbortSignal.any([signal, deadline])
        : (signal ?? deadline);
    let response;
    let text;
    try {
      response = await withAbort(async () => {
        const headers = await options.headers();
        combined?.throwIfAborted();
        return send(new URL(CLEF_DECISIONS_PATH, options.baseUrl), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: combined,
        });
      }, combined);
      // A cut-off or late body is no usable response either.
      const reply = response;
      text = await withAbort(() => reply.text(), combined);
    } catch {
      signal?.throwIfAborted();
      // error-policy:J2 an unreachable or late Cloud is the documented unavailable answer.
      return unavailable(null, "provider_error");
    }
    if (response.status === 400 || response.status === 401)
      throw new Error(`Clef decision request was refused (${response.status})`);
    const body = parseJson(text);
    if (!response.ok || body?.status !== "ok" || body.kind !== request.kind)
      return unavailable(
        response.status,
        body?.status === "unavailable" ? body.reason : "provider_error",
      );
    return body;
  };
}
