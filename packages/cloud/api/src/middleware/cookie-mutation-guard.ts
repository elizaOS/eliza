/**
 * Global CSRF guard for cookie-authenticated mutations, mounted directly after
 * `authMiddleware` in bootstrap-app.ts. A mutating `/api/*` request that
 * carries the ambient Steward session cookie — and no programmatic credential —
 * must pass the Eliza browser-origin policy AND bear a non-simple request
 * marker; safe methods, programmatic credentials (API key / service key /
 * Bearer), and cookie-less traffic pass through to the route's own auth.
 *
 * This closes the same-site hosted-user-content CSRF lane: pages served from
 * the managed-frontend suffix share a registrable domain with the API, so a
 * cross-origin "simple" request from them would otherwise ride the victim's
 * session cookie into org mutations.
 */

import type { MiddlewareHandler } from "hono";
import { checkCookieMutationGuard } from "@/lib/auth/cookie-mutation-guard";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const cookieMutationGuardMiddleware: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
    await next();
    return;
  }
  const pathname = new URL(c.req.url).pathname;
  if (!pathname.startsWith("/api/")) {
    await next();
    return;
  }
  const verdict = checkCookieMutationGuard(
    c.req,
    c.env?.ENVIRONMENT,
    c.env?.NODE_ENV === "production",
  );
  if (!verdict.ok) {
    logger.warn(
      "[CookieMutationGuard] rejected cookie-authenticated mutation",
      {
        path: pathname,
        code: verdict.code,
        detail: verdict.reason,
      },
    );
    return c.json({ error: "Forbidden", code: verdict.code }, 403);
  }
  await next();
};
