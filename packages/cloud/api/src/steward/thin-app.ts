/**
 * Thin Hono shell for login-critical Steward GETs (#18049).
 *
 * The monolithic bootstrap loads ~580 routes and service singletons (e.g.
 * PayoutAlerts) before the embedded Steward proxy runs. Cold isolates then
 * spend multi-second module-init on the anonymous `/steward/auth/providers`
 * path that gates the sign-in buttons.
 *
 * This shell mounts only CORS + the embedded Steward handler so those GETs
 * never evaluate `bootstrap-app` / `_router.generated`. Mutating Steward auth
 * still uses the full app (signing, rate limits, observability).
 */

import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
import type { AppEnv } from "@/types/cloud-worker-env";
import { embeddedStewardHandler } from "./embedded";

export function createStewardThinApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });

  app.use("*", requestId());
  app.use("*", corsMiddleware);
  app.use(
    "*",
    secureHeaders({
      xContentTypeOptions: "nosniff",
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
      crossOriginResourcePolicy: "cross-origin",
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
    }),
  );

  app.all("/steward", embeddedStewardHandler);
  app.all("/steward/*", embeddedStewardHandler);

  return app;
}
