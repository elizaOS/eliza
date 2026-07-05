/**
 * Pure decision logic for the chat-history relaunch-persistence lane (#13689):
 * "my conversation is still there after I reopen the app". The device/HTTP legs
 * in mobile-local-chat-smoke.mjs drive the real path — send a unique marker
 * through the running agent, kill+relaunch the app process, re-fetch the thread
 * from server truth (`GET /api/conversations/:id/messages`) — but the accept/
 * reject verdict lives here so it is verifiable off-device and can never
 * false-green: a run that never sent the marker, or one whose after-relaunch
 * fetch is empty (fresh state dir / lost DB), throws loudly instead of passing.
 *
 * The marker is unique per run so residue from a prior run (the exact pollution
 * this issue calls out in GestureSemanticsUITests) cannot satisfy the check.
 * Parsing the server response is fail-fast (issue #9324 doctrine, THROW never
 * fabricate): a malformed body is a broken pipeline, not an empty thread — only
 * a well-formed `{ messages: [] }` is a legitimately empty thread.
 */

/** Error raised by this module; `code` lets callers branch without string-matching. */
export class ChatHistoryPersistenceError extends Error {
  constructor(message, code, context) {
    super(message);
    this.name = "ChatHistoryPersistenceError";
    this.code = code;
    if (context) this.context = context;
  }
}

export const RELAUNCH_MARKER_PREFIX = "RELAUNCH-PERSIST";
const RELAUNCH_MARKER_RE = new RegExp(
  `^${RELAUNCH_MARKER_PREFIX}-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+-\\d{10,}-[A-Za-z0-9]{8,}$`,
);

function markerSegment(value, fallback) {
  const sanitized = String(value ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .trim();
  return sanitized || fallback;
}

function markerRandomSegment(value, fallback) {
  const sanitized = String(value ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .trim();
  return sanitized.length >= 8 ? sanitized : fallback;
}

/**
 * A per-run unique marker string. The timestamp + random suffix guarantee that
 * a message left over from a previous run can never satisfy the survival check,
 * and `platform`/`runId` make failures self-describing in logs.
 */
export function buildRelaunchMarker({
  platform = "app",
  runId,
  now = Date.now(),
  random,
} = {}) {
  const generatedRand = Math.random().toString(36).slice(2, 10);
  const rand = markerRandomSegment(random, generatedRand);
  const platformSegment = markerSegment(platform, "app");
  const run = markerSegment(runId, rand);
  return `${RELAUNCH_MARKER_PREFIX}-${platformSegment}-${run}-${now}-${rand}`;
}

/** True only for a marker with the full shape emitted by `buildRelaunchMarker`. */
export function isRelaunchMarker(value) {
  return typeof value === "string" && RELAUNCH_MARKER_RE.test(value);
}

/**
 * Extract the ordered message texts from a `GET /api/conversations/:id/messages`
 * body (`{ messages: [{ role, text }] }`). Throws on a malformed body so a
 * broken read is never mistaken for an empty thread; `{ messages: [] }` returns
 * `[]` because that is a real (empty) thread, not a pipeline failure.
 */
export function extractMessageTexts(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ChatHistoryPersistenceError(
      `Malformed GET /messages body (expected an object): ${JSON.stringify(body)}`,
      "MALFORMED_BODY",
    );
  }
  const { messages } = body;
  if (!Array.isArray(messages)) {
    throw new ChatHistoryPersistenceError(
      `GET /messages body is missing a \`messages\` array: ${JSON.stringify(body)}`,
      "MISSING_MESSAGES",
    );
  }
  return messages.map((m, index) => {
    if (!m || typeof m !== "object") {
      throw new ChatHistoryPersistenceError(
        `GET /messages entry ${index} is not an object`,
        "MALFORMED_MESSAGE",
        { index },
      );
    }
    const text = m.text;
    if (typeof text !== "string") {
      throw new ChatHistoryPersistenceError(
        `GET /messages entry ${index} has a non-string text field`,
        "MALFORMED_MESSAGE",
        { index, role: m.role },
      );
    }
    return text;
  });
}

/** Whether the server-truth thread body contains the marker text. */
export function messageThreadContainsMarker(body, marker) {
  return extractMessageTexts(body).some((text) => text.includes(marker));
}

/**
 * Assert a sent marker survived an app relaunch.
 *
 * `beforeBody` proves the marker actually reached server truth before the
 * relaunch (guards a broken send that would otherwise let the leg pass without
 * ever testing persistence); `afterBody` is the thread re-fetched from a freshly
 * relaunched process. A marker absent from `afterBody` — the fresh-state-dir /
 * lost-DB regression this issue guards — throws loudly. Returns a summary for
 * the caller to log as evidence.
 */
export function assertMarkerSurvivedRelaunch({
  marker,
  beforeBody,
  afterBody,
}) {
  if (!isRelaunchMarker(marker)) {
    throw new ChatHistoryPersistenceError(
      `Refusing to assert a non-unique marker: ${JSON.stringify(marker)}`,
      "INVALID_MARKER",
    );
  }

  const beforeTexts = extractMessageTexts(beforeBody);
  if (!beforeTexts.some((text) => text.includes(marker))) {
    throw new ChatHistoryPersistenceError(
      `Marker "${marker}" was not present in the thread BEFORE relaunch — the send never reached server truth, so persistence cannot be asserted. Pre-relaunch thread had ${beforeTexts.length} message(s).`,
      "MARKER_NOT_SENT",
      { marker, beforeCount: beforeTexts.length },
    );
  }

  const afterTexts = extractMessageTexts(afterBody);
  if (!afterTexts.some((text) => text.includes(marker))) {
    throw new ChatHistoryPersistenceError(
      `Chat history did NOT survive relaunch: marker "${marker}" is absent from the server-truth thread after relaunch (${afterTexts.length} message(s) returned). A regression that empties the thread on relaunch — or a fresh/lost agent state dir — trips this.`,
      "MARKER_LOST_ON_RELAUNCH",
      {
        marker,
        beforeCount: beforeTexts.length,
        afterCount: afterTexts.length,
      },
    );
  }

  return {
    marker,
    beforeCount: beforeTexts.length,
    afterCount: afterTexts.length,
    survived: true,
  };
}
