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
