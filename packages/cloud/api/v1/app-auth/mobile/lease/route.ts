import {
  endMobileMailLease,
  rotateMobileMailLease,
} from "@elizaos/cloud-shared/db/repositories/mobile-mail-leases";
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { apiKeysService } from "@elizaos/cloud-shared/lib/services/api-keys";
import { verifyMobileMailLeaseRegistration } from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  MOBILE_APP_AUTH_LEASE_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
} from "../_rate-limit";

const app = new Hono<AppEnv>();
app.use(
  "*",
  mobileAppAuthRateLimitMiddleware(MOBILE_APP_AUTH_LEASE_RATE_LIMIT),
);

function presentedRefresh(c: AppContext): string {
  if (c.req.header("X-API-Key")) return "";
  return (
    /^Bearer ([^\s]+)$/iu.exec(c.req.header("Authorization") ?? "")?.[1] ?? ""
  );
}

app.post("/", async (c) => {
  try {
    const result = await rotateMobileMailLease(presentedRefresh(c));
    if (result.kind === "offered") {
      await verifyMobileMailLeaseRegistration(c.env, result.principal);
      return c.json({ success: true, ...result.tokens });
    }
    if (result.kind === "reused") {
      await apiKeysService.revokeMobileSessionForReuse(
        result.principal.credentialId,
        result.principal.organizationId,
      );
    }
    throw new ApiError(
      401,
      "authentication_required",
      "The mail lease is no longer valid",
      {
        reason:
          result.kind === "reused"
            ? "credential_revoked"
            : "credential_unknown",
      },
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const reused = await endMobileMailLease(presentedRefresh(c));
    if (reused) {
      await apiKeysService.revokeMobileSessionForReuse(
        reused.credentialId,
        reused.organizationId,
      );
    }
    return c.body(null, 204);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
