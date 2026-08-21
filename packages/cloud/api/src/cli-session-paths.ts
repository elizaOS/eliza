/**
 * Paths served by the thin CLI-session shell (#22948).
 *
 * The login-hot-path lifecycle the CLI/desktop flow uses: session create
 * (POST), status poll (GET), delivery acknowledgement (PATCH),
 * and exact-key cancellation (DELETE). OPTIONS preflight is eligible for both
 * paths; HEAD is explicitly rejected by the mounted poll route because GET is
 * a single-use credential claim.
 * The authenticated `/:sessionId/complete` mutation stays on the full app — it
 * needs the complete auth middleware stack — and is excluded here by the
 * single-segment constraint, not by handler-side dispatch.
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
    return (
      upper === "GET" ||
      upper === "HEAD" ||
      upper === "PATCH" ||
      upper === "DELETE" ||
      upper === "OPTIONS"
    );
  }
  return false;
}
