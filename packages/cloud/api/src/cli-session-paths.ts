/**
 * Paths served by the thin CLI-session shell (#22948).
 *
 * Only the two login-hot-path endpoints the CLI/desktop flow hammers:
 * session create (POST) and status poll (GET). OPTIONS preflight is eligible
 * for both paths; HEAD is eligible for the poll (Hono answers HEAD via the
 * GET handler). The authenticated `/:sessionId/complete` mutation stays on
 * the full app — it needs the complete auth middleware stack — and is
 * excluded here by the single-segment constraint, not by handler-side
 * dispatch.
 */

const CLI_SESSION_CREATE_PATH = /^\/api\/auth\/cli-session\/?$/;
const CLI_SESSION_POLL_PATH = /^\/api\/auth\/cli-session\/[^/]+\/?$/;

export function isThinCliSessionPath(
  method: string,
  pathname: string,
): boolean {
  const upper = method.toUpperCase();
  if (CLI_SESSION_CREATE_PATH.test(pathname)) {
    return upper === "POST" || upper === "OPTIONS";
  }
  if (CLI_SESSION_POLL_PATH.test(pathname)) {
    return upper === "GET" || upper === "HEAD" || upper === "OPTIONS";
  }
  return false;
}
