/**
 * The onboarding liveness contract: the single, surface-agnostic rule that a
 * post-onboarding chat reply came from a REAL model and not the deterministic
 * stub. Consumed by the Playwright wrapper (`liveness-contract.ts`), the iOS
 * simulator harness (`scripts/ios-onboarding-smoke.mjs`), and the in-app iOS
 * verifier (`src/main.tsx`) — every onboarding surface asserts liveness through
 * this one implementation so the check cannot drift between lanes (#14359).
 *
 * This module is intentionally pure and dependency-free (plain `.mjs`) so it is
 * importable from both the bundled renderer and the un-bundled Node harness
 * without a build step. All DOM/Playwright driving lives in the `.ts` wrapper.
 */

/**
 * The deterministic keyless stub tags every reply with this fixture id. A real
 * model turn must never contain it — that is how liveness is proven. Kept here
 * as the one source of truth; the stub emitter
 * (`packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs`) writes the same
 * literal, so if that fixture id ever changes both sides update together.
 */
export const STUB_FIXTURE_MARKER = "ui-smoke-assistant-v1";

/**
 * Thrown when a reply fails the liveness contract. Distinct type so harnesses
 * can attribute a failure to liveness rather than a generic timeout/DOM error.
 */
export class LivenessAssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "LivenessAssertionError";
  }
}

/**
 * Assert a rendered assistant reply proves a real model answered.
 *
 * A live reply must be a non-empty string that does not carry the stub fixture
 * marker. Empty/whitespace-only conflates "model never answered" with a real
 * turn; the stub marker conflates the deterministic fixture with a real turn —
 * both are false-green failures this contract exists to catch. Throws
 * `LivenessAssertionError` on failure; returns the trimmed reply on success.
 *
 * @param {unknown} reply the assistant reply text as rendered in the UI
 * @param {{ label?: string }} [options] label for error attribution (lane name)
 * @returns {string} the trimmed, validated reply
 */
export function assertLiveReply(reply, options = {}) {
  const label = options.label ? `${options.label}: ` : "";
  if (typeof reply !== "string") {
    throw new LivenessAssertionError(
      `${label}liveness reply must be a string, got ${reply === null ? "null" : typeof reply}`,
    );
  }
  const text = reply.trim();
  if (text.length === 0) {
    throw new LivenessAssertionError(
      `${label}liveness reply was empty — the model produced no answer`,
    );
  }
  if (text.includes(STUB_FIXTURE_MARKER)) {
    throw new LivenessAssertionError(
      `${label}liveness reply carried the stub fixture marker "${STUB_FIXTURE_MARKER}" — a real model did not answer`,
    );
  }
  return text;
}

/**
 * Non-throwing predicate form of {@link assertLiveReply}, for harnesses that
 * branch on liveness rather than fail. Returns true only for a real reply.
 *
 * @param {unknown} reply
 * @returns {boolean}
 */
export function isLiveReply(reply) {
  try {
    assertLiveReply(reply);
    return true;
  } catch {
    // error-policy:J3 predicate form — a rejected reply is a definite "not live"
    // signal, never a swallowed error (the throwing form is the enforcement path)
    return false;
  }
}

/**
 * Find the assistant reply structurally paired with one run-unique user turn.
 *
 * The token is required only in the user row. A model may answer the exact
 * turn without copying an arbitrary code verbatim; requiring an echo confuses
 * instruction-following with liveness. DOM order still binds the reply to the
 * run: the first assistant row after the token-bearing user row owns the turn
 * and must settle as uninterrupted, non-failure model text. The helper never
 * skips an invalid owner row to accept unrelated content further down.
 *
 * This helper consumes a privacy-sensitive in-memory transcript snapshot but
 * returns only indices plus the validated candidate text. Callers must never
 * serialize either the token or reply into CI evidence.
 *
 * @param {Array<{
 *   role?: string,
 *   text?: string,
 *   failureKind?: string,
 *   hasRetry?: boolean,
 *   interrupted?: boolean,
 *   hasMessageText?: boolean | null,
 *   phase?: string | null,
 * }>} lines ordered thread rows
 * @param {{ anchorToken?: string }} [options]
 * @returns {{ userLineIndex: number, assistantLineIndex: number, reply: string } | null}
 */
export function findAnchoredLiveTurn(lines, { anchorToken } = {}) {
  const token = String(anchorToken ?? "")
    .trim()
    .toLowerCase();
  if (!token || !Array.isArray(lines)) return null;

  for (
    let userLineIndex = 0;
    userLineIndex < lines.length;
    userLineIndex += 1
  ) {
    const userLine = lines[userLineIndex];
    if (
      userLine?.role !== "user" ||
      !String(userLine.text ?? "")
        .toLowerCase()
        .includes(token)
    ) {
      continue;
    }

    for (
      let assistantLineIndex = userLineIndex + 1;
      assistantLineIndex < lines.length;
      assistantLineIndex += 1
    ) {
      const line = lines[assistantLineIndex];
      if (line?.role === "user") return null;
      if (line?.role !== "assistant") continue;
      // The first assistant row after the anchored user owns this turn. A
      // pending row may become a reply on a later poll; a terminal failure,
      // retry, interruption, or widget-only body must never be skipped in
      // favour of an unrelated assistant row further down the transcript.
      if (String(line.failureKind ?? "").trim()) return null;
      if (
        line.hasRetry === true ||
        line.interrupted === true ||
        line.hasMessageText === false ||
        line.phase === "status"
      ) {
        return null;
      }
      const reply = String(line.text ?? "").trim();
      if (!reply) return null;
      return { userLineIndex, assistantLineIndex, reply };
    }
    return null;
  }
  return null;
}

/**
 * Reduce the first assistant row owned by an anchored user turn to a
 * privacy-safe diagnostic. This deliberately returns no text, token, indices,
 * IDs, or failure value. It mirrors {@link findAnchoredLiveTurn}'s ownership
 * boundary so a hosted failure can distinguish a missing anchor, a missing
 * assistant row, and an ineligible owner row without persisting conversation
 * content.
 *
 * @param {Array<{
 *   role?: string,
 *   text?: string,
 *   failureKind?: string,
 *   hasRetry?: boolean,
 *   interrupted?: boolean,
 *   hasMessageText?: boolean | null,
 *   phase?: string | null,
 * }>} lines ordered thread rows
 * @param {{ anchorToken?: string }} [options]
 * @returns {{
 *   anchorUserPresent: boolean,
 *   assistantRowPresent: boolean,
 *   assistantFailurePresent: boolean,
 *   assistantRetryPresent: boolean,
 *   assistantInterrupted: boolean,
 *   assistantHasMessageText: boolean | null,
 *   assistantPhase: "status" | "reply" | "other" | null,
 *   assistantHasText: boolean,
 * }}
 */
export function describeAnchoredLiveTurnState(lines, { anchorToken } = {}) {
  const unavailable = {
    anchorUserPresent: false,
    assistantRowPresent: false,
    assistantFailurePresent: false,
    assistantRetryPresent: false,
    assistantInterrupted: false,
    assistantHasMessageText: null,
    assistantPhase: null,
    assistantHasText: false,
  };
  const token = String(anchorToken ?? "")
    .trim()
    .toLowerCase();
  if (!token || !Array.isArray(lines)) return unavailable;

  const userLineIndex = lines.findIndex(
    (line) =>
      line?.role === "user" &&
      String(line.text ?? "")
        .toLowerCase()
        .includes(token),
  );
  if (userLineIndex < 0) return unavailable;
  const anchorOnly = { ...unavailable, anchorUserPresent: true };
  for (
    let assistantLineIndex = userLineIndex + 1;
    assistantLineIndex < lines.length;
    assistantLineIndex += 1
  ) {
    const line = lines[assistantLineIndex];
    if (line?.role === "user") return anchorOnly;
    if (line?.role !== "assistant") continue;
    const phase = String(line.phase ?? "").trim();
    return {
      anchorUserPresent: true,
      assistantRowPresent: true,
      assistantFailurePresent: Boolean(String(line.failureKind ?? "").trim()),
      assistantRetryPresent: line.hasRetry === true,
      assistantInterrupted: line.interrupted === true,
      assistantHasMessageText:
        typeof line.hasMessageText === "boolean" ? line.hasMessageText : null,
      assistantPhase:
        phase === "status" || phase === "reply"
          ? phase
          : phase
            ? "other"
            : null,
      assistantHasText: Boolean(String(line.text ?? "").trim()),
    };
  }
  return anchorOnly;
}

/**
 * The challenge suffix shared by every liveness lane that binds the reply to
 * the exact run. The token after the colon is what the harness generates fresh
 * per run and what the reply must echo back. Kept as the one literal so the
 * iOS prompt writer, the Android prompt writer, and the verification all agree.
 */
export const LIVENESS_CHALLENGE_PREFIX =
  "Reply with exactly this code to confirm you are live:";

/**
 * Extract the run-unique challenge token from a challenge prompt produced by
 * {@link buildLivenessChallenge}. The harness — never the client — owns token
 * generation, so verification re-derives the expected token from the exact
 * prompt it wrote; anything else would make the binding theater.
 *
 * @param {string} prompt the challenge prompt this harness generated and sent
 * @returns {string} the lowercase hex token ("" when the prompt carries none)
 */
export function extractLivenessChallengeToken(prompt) {
  if (typeof prompt !== "string") return "";
  const marker = `${LIVENESS_CHALLENGE_PREFIX} `;
  const at = prompt.lastIndexOf(marker);
  if (at === -1) return "";
  return prompt
    .slice(at + marker.length)
    .trim()
    .toLowerCase();
}

/**
 * Build the run-unique liveness challenge prompt around a caller-supplied
 * token. Both SIWE device lanes call this with a fresh random hex token so the
 * reply can only pass by echoing this run's token.
 *
 * @param {string} token run-unique token (fresh random hex from the harness)
 * @returns {string} the full prompt to send through the composer
 */
export function buildLivenessChallenge(token) {
  return `${LIVENESS_CHALLENGE_PREFIX} ${token}`;
}

/**
 * Assert a rendered assistant reply is live AND answers this exact run: the
 * shared {@link assertLiveReply} rules first (non-empty, no stub marker), then
 * the reply must contain the run's challenge token (case-insensitive). This is
 * the assertion the SIWE cloud-onboarding lanes enforce — a pending status row
 * ("Thinking", "Thinking · 1s", "Replying"), a cached greeting, or a wrong-code
 * reply all fail here.
 *
 * Containment is a plain case-insensitive substring, immune to markdown
 * wrapping ("The code is `abc123`") and spacing; only text produced by
 * something that saw this run's prompt can contain a fresh random token.
 *
 * @param {unknown} reply the assistant reply text as rendered in the UI
 * @param {{ challengeToken: string, label?: string }} options the token this
 *   run's harness generated (lowercased internally; "" always fails)
 * @returns {string} the trimmed, validated reply
 */
export function assertLiveChallengeReply(
  reply,
  { challengeToken, label } = {},
) {
  const text = assertLiveReply(reply, { label });
  const expected = String(challengeToken ?? "")
    .trim()
    .toLowerCase();
  if (!expected) {
    throw new LivenessAssertionError(
      `${label ? `${label}: ` : ""}liveness challenge token is missing — cannot bind the reply to this run`,
    );
  }
  if (!text.toLowerCase().includes(expected)) {
    throw new LivenessAssertionError(
      `${label ? `${label}: ` : ""}liveness reply did not echo this run's challenge token "${expected}" — the reply did not provably come from this exact turn`,
    );
  }
  return text;
}
