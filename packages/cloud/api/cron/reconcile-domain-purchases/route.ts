/**
 * Reconciles durable domain purchases whose registrar or local completion outcome is pending.
 *
 * The buy route and this cron share the same compare-and-set state machine. A
 * claimed registrar operation is never repeated: this worker polls the domain's
 * provider status, refunds a verified failure once, or finishes local assignment.
 */

import { type Context, Hono } from "hono";
import { domainPurchaseAttemptsRepository } from "@/db/repositories/domain-purchase-attempts";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  executeDomainPurchase,
  getPinnedDomainPurchaseYears,
} from "../../v1/apps/[id]/domains/buy/route";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    const attempts =
      await domainPurchaseAttemptsRepository.listDueReconciliation({
        now: new Date(),
        limit: 25,
      });
    let processed = 0;
    for (const attempt of attempts) {
      try {
        const appRow = await appsService.getById(attempt.app_id);
        if (!appRow || appRow.organization_id !== attempt.organization_id) {
          logger.error(
            "[Domain Purchase Reconciler] attempt app binding is invalid",
            {
              attemptId: attempt.id,
            },
          );
          continue;
        }
        await executeDomainPurchase({
          organizationId: attempt.organization_id,
          appId: attempt.app_id,
          appUrl: appRow.app_url,
          domain: attempt.domain,
          requestDigest: attempt.request_digest ?? "",
          years: getPinnedDomainPurchaseYears(attempt),
          attempt,
        });
        processed += 1;
      } catch (error) {
        // error-policy:J7 One malformed or unavailable purchase must not stop
        // the other durable attempts; its row remains due for the next claim.
        logger.error("[Domain Purchase Reconciler] attempt failed", {
          attemptId: attempt.id,
          error,
        });
      }
    }
    return c.json({ success: true, claimed: attempts.length, processed });
  } catch (error) {
    // error-policy:J1 The cron transport boundary returns the shared structured failure.
    logger.error("[Domain Purchase Reconciler] cron failed", { error });
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
