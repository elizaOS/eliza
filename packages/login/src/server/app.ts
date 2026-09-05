/**
 * Assembles the first-party identity API with authentication before idempotency.
 * Existing identity and wallet routes retain their persisted protocol contracts;
 * trading venues, strategies and DeFi adapter routes are not mounted.
 */

import { logger } from "@elizaos/logger";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authorizationSignature } from "./api/src/middleware/authorization-signature";
import { correlationId } from "./api/src/middleware/correlation";
import { workersGlobalRateLimit } from "./api/src/middleware/global-rate-limit";
import { idempotencyMiddleware } from "./api/src/middleware/idempotency";
import { requestExpiry } from "./api/src/middleware/request-expiry";
import { requestLogger } from "./api/src/middleware/request-logger";
import { securityHeaders } from "./api/src/middleware/security-headers";
import { tenantCors } from "./api/src/middleware/tenant-cors";
import { agentRoutes, createAgentBatch } from "./api/src/routes/agents";
import { approvalRoutes } from "./api/src/routes/approvals";
import { authRoutes } from "./api/src/routes/auth";
import { dashboardRoutes } from "./api/src/routes/dashboard";
import { identityDiscoveryRoutes } from "./api/src/routes/discovery";
import { globalWalletRoutes } from "./api/src/routes/global-wallet";
import { kmsRoutes } from "./api/src/routes/kms";
import { platformRoutes } from "./api/src/routes/platform";
import { tenantConfigRoutes } from "./api/src/routes/tenant-config";
import { tenantRoutes } from "./api/src/routes/tenants";
import { userRoutes, userSessionAuth } from "./api/src/routes/user";
import { vaultRoutes } from "./api/src/routes/vault";
import {
  type AppVariables,
  dashboardAuthMiddleware,
  tenantAuth,
} from "./api/src/services/context";
import {
  platformAuthMiddleware,
  SmsDeliveryError,
  SmsVerificationError,
} from "./auth/src/index";
import { redactedThrownDiagnostics } from "./shared/src/index";
import { runtimeEnvironmentValue } from "./shared/src/runtime-env";

/** Creates a router without starting a process, mutating a database or installing timers. */
export function createLoginApp(): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  // error-policy:J1 translate failures at the HTTP boundary without leaking credentials.
  app.onError((error, c) => {
    if (error instanceof SyntaxError)
      return c.json({ ok: false, error: "Invalid JSON" }, 400);
    if (
      error instanceof SmsDeliveryError ||
      error instanceof SmsVerificationError
    ) {
      return c.json(
        { ok: false, error: "SMS verification is temporarily unavailable" },
        503,
      );
    }
    logger.error(
      { ...redactedThrownDiagnostics(error), requestId: c.get("requestId") },
      "[Login] Request failed",
    );
    return c.json({ ok: false, error: "Internal server error" }, 500);
  });
  app.notFound((c) => c.json({ ok: false, error: "Not found" }, 404));
  app.use("*", workersGlobalRateLimit);
  app.use("*", securityHeaders);
  app.use("*", tenantCors);
  app.use("*", requestLogger());
  app.use("*", correlationId);
  app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  app.use("*", (c, next) =>
    requestExpiry({
      required:
        runtimeEnvironmentValue("STEWARD_REQUIRE_REQUEST_EXPIRY") === "true",
    })(c, next),
  );
  app.use("*", (c, next) =>
    authorizationSignature({
      required:
        runtimeEnvironmentValue("STEWARD_REQUIRE_AUTH_SIGNATURE") === "true",
    })(c, next),
  );
  for (const prefix of [
    "/agents",
    "/v1/agents",
    "/vault",
    "/v1/kms",
    "/approvals",
  ]) {
    app.use(`${prefix}/*`, (c, next) => tenantAuth(c, next));
  }
  app.use("/wallets/batch", (c, next) => tenantAuth(c, next));
  app.use("/v1/wallets/batch", (c, next) => tenantAuth(c, next));
  app.use("/tenants/:id", (c, next) => {
    const id = c.req.param("id");
    if (id === "config" && c.req.method === "GET") return next();
    return tenantAuth(c, next, { requireTenantMatch: id });
  });
  app.use("/tenants/:id/*", (c, next) =>
    tenantAuth(c, next, { requireTenantMatch: c.req.param("id") }),
  );
  app.use("/dashboard/*", (c, next) => dashboardAuthMiddleware(c, next));
  app.use("/platform", platformAuthMiddleware());
  app.use("/platform/*", platformAuthMiddleware());
  app.use("/user", userSessionAuth);
  app.use("/user/*", userSessionAuth);
  app.use("*", idempotencyMiddleware());
  app.get("/health", (c) => c.json({ status: "ok", name: "@elizaos/login" }));
  app.route("/", identityDiscoveryRoutes);
  app.route("/auth", authRoutes);
  app.route("/platform", platformRoutes);
  app.route("/user", userRoutes);
  app.route("/global-wallet", globalWalletRoutes);
  app.route("/agents", agentRoutes);
  app.route("/v1/agents", agentRoutes);
  app.post("/wallets/batch", createAgentBatch);
  app.post("/v1/wallets/batch", createAgentBatch);
  app.route("/vault", vaultRoutes);
  app.route("/v1/kms", kmsRoutes);
  // Literal discovery routes must precede the tenant-ID wildcard.
  app.route("/tenants", tenantConfigRoutes);
  app.route("/tenants", tenantRoutes);
  app.route("/approvals", approvalRoutes);
  app.route("/dashboard", dashboardRoutes);
  return app;
}
