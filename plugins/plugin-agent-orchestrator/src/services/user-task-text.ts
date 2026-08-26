/**
 * Extracts the user's verbatim request from an augmented child prompt. The
 * spawn path wraps the user task in injected sections ("--- Swarm
 * Coordination ---", "--- Publishing web apps (custom host) ---", ...) with
 * the verbatim ask between the "--- User Task ---" marker and the NEXT
 * section header. Slicing only from the marker to end-of-string drags every
 * trailing guidance section into successor tasks — a redirected follow-up
 * then derives its title, slug, and workdir from guidance prose (live
 * 2026-08-20: successor titled "elizaos --- Publishing web apps (custom
 * host) ---..." with a matching junk app dir).
 */
export const USER_TASK_MARKER = "--- User Task ---";

const SECTION_HEADER_RE = /^--- .+? ---$/m;

export function userTaskFromInitialTask(raw: string | undefined): string {
  if (!raw) return "";
  const at = raw.lastIndexOf(USER_TASK_MARKER);
  if (at < 0) return raw.trim();
  const after = raw.slice(at + USER_TASK_MARKER.length);
  const next = after.search(SECTION_HEADER_RE);
  return (next >= 0 ? after.slice(0, next) : after).trim();
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Whitespace-insensitive, case-insensitive containment for prompt text —
 *  the shared "does this prompt already carry that text" predicate behind
 *  every verbatim-ask dedupe (here and in goal-prompt). */
export function textuallyContains(haystack: string, needle: string): boolean {
  return squash(haystack).includes(squash(needle));
}

/** Framing line that introduces the verbatim ask inside a User Task body. */
export const VERBATIM_REQUEST_HEADING =
  "Original user request (verbatim, authoritative):";

/**
 * Compose the User Task section BODY from the planner's task text and the
 * user's verbatim request. The planner routinely hands the spawn path a short
 * label ("demo-hello page") instead of the ask; the child then builds the
 * label while the verifier grades against the stored verbatim
 * `originalRequest` and fails it for features it was never told about (live
 * 2026-08-21, task 5c6d85c0: "gradient and the current date" never reached
 * the builder; three verify laps burned, task parked).
 *
 * - No verbatim request (or blank): the task text stands alone.
 * - Either text already contains the other (whitespace/case-insensitive):
 *   the longer, information-complete one stands alone — never duplicated.
 * - Otherwise the short task text PREFIXES the verbatim ask (the label keeps
 *   deriving titles/slugs from the body's first line), with the verbatim
 *   request emitted COMPLETE below it under {@link VERBATIM_REQUEST_HEADING}.
 *
 * The composed body must live INSIDE the "--- User Task ---" section so
 * {@link userTaskFromInitialTask} hands successors the same complete ask.
 */
export function composeUserTaskBody(
  task: string,
  verbatimRequest: string | undefined,
): string {
  const base = (task ?? "").trim();
  const verbatim = (verbatimRequest ?? "").trim();
  if (!verbatim) return base;
  if (!base) return verbatim;
  const squashedBase = squash(base);
  const squashedVerbatim = squash(verbatim);
  if (squashedBase.includes(squashedVerbatim)) return base;
  if (squashedVerbatim.includes(squashedBase)) return verbatim;
  return `${base}\n\n${VERBATIM_REQUEST_HEADING}\n${verbatim}`;
}
