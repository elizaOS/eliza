/**
 * POST /api/v1/decisions
 *
 * Small typed judgments from Cloudflare's Clef decision model: which page
 * control fits a goal (`choice`), whether an action should ask first (`mode`),
 * and whether a spoken turn is finished (`turn`). The contract and its limits
 * live in `@elizaos/cloud-sdk/clef-decisions`. Clients call Clef only through
 * this route, never with their own Workers AI key.
 *
 * The route is off unless `CLEF_DECISIONS_ENABLED=true` and the `AI` binding is
 * present. Off or failing, it answers 503 `{ status: "unavailable" }` so
 * clients keep their own rule. A `mode` answer is a suggestion; it never lowers
 * a client's safety floor. Request text is not stored or logged.
 *
 * Clef calls do not debit credits. Shared Redis enforces 30 requests a minute
 * per credential and a daily cap across the organization's credentials.
 * The daily cap is 2,000, or 4,000 with a qualifying purchase. An active paid
 * subscription renews included capacity each minute at its organization rate.
 */

import {
  type ClefDecisionRequest,
  clefDecisionRequestProblem,
} from "@elizaos/cloud-sdk/clef-decisions";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  type RateLimitConfig,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  ClefDecisionError,
  resolveClefModel,
  runClefDecision,
} from "@elizaos/cloud-shared/lib/providers/cloudflare-clef";
import { resolveOrgTierFromSourceValues } from "@elizaos/cloud-shared/lib/services/org-rate-limits";
import { readOrganizationQuotaPolicy } from "@elizaos/cloud-shared/lib/services/organization-quota-policy";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";

/** Per credential (API key, else user or IP), checked before authentication. */
const CLEF_DECISIONS_CREDENTIAL_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 30,
};

/** Per organization, across all its keys and users; only Clef calls count. */
const CLEF_DECISIONS_DAILY_WINDOW_MS = 86_400_000;
const CLEF_DECISIONS_DAILY_LIMIT = 2_000;
const CLEF_DECISIONS_FUNDED_DAILY_LIMIT = 4_000;

type DecisionQuota =
  | { kind: "daily"; maxRequests: number }
  | { kind: "subscription"; rpm: number };

const BASE_DECISION_QUOTA: DecisionQuota = {
  kind: "daily",
  maxRequests: CLEF_DECISIONS_DAILY_LIMIT,
};

async function organizationDecisionQuota(
  organizationId: string,
): Promise<DecisionQuota> {
  try {
    const policy = await readOrganizationQuotaPolicy(organizationId);
    if (policy.tier.status !== "available") return BASE_DECISION_QUOTA;
    if (
      policy.authority.source === "subscription" &&
      policy.subscriptionFunded
    ) {
      return { kind: "subscription", rpm: policy.tier.value.strictRpm };
    }
    if (
      policy.tierSourceCreditTotal !== null &&
      resolveOrgTierFromSourceValues(
        organizationId,
        policy.tierSourceCreditTotal,
      ).tierData.tierName !== "free"
    ) {
      return { kind: "daily", maxRequests: CLEF_DECISIONS_FUNDED_DAILY_LIMIT };
    }
  } catch {
    // error-policy:J2 An unavailable funding decision preserves the base cap.
    logger.warn("[Decisions] Funded quota policy unavailable", {
      organizationId,
    });
  }
  return BASE_DECISION_QUOTA;
}

const SCOPE_HEADER = "X-Clef-Rate-Limit-Scope";

async function checkOrganizationLimit(
  c: Context<AppEnv>,
  config: RateLimitConfig,
  scope: "organization-day" | "subscription-minute",
): Promise<Response | null> {
  let admitted = false;
  const blocked = await moneyRateLimit(config)(c, async () => {
    admitted = true;
  });
  if (admitted) return null;
  const refusal =
    blocked ?? c.json({ status: "unavailable", reason: "rate_limited" }, 503);
  refusal.headers.set(SCOPE_HEADER, scope);
  return refusal;
}

async function admitOrganizationDecision(
  c: Context<AppEnv>,
  organizationId: string,
): Promise<Response | null> {
  const quota = await organizationDecisionQuota(organizationId);
  const dailyKey = `clef-decisions:org:${organizationId}`;
  // Hono copies the response headers after initialization. A discarded daily
  // refusal must not publish its retry or limit headers on renewed requests.
  if (quota.kind === "subscription") void c.res;

  const dailyRefusal = await checkOrganizationLimit(
    c,
    {
      windowMs: CLEF_DECISIONS_DAILY_WINDOW_MS,
      maxRequests:
        quota.kind === "subscription"
          ? CLEF_DECISIONS_FUNDED_DAILY_LIMIT
          : quota.maxRequests,
      keyGenerator: () => dailyKey,
    },
    "organization-day",
  );
  if (!dailyRefusal) {
    c.header(SCOPE_HEADER, "organization-day");
    return null;
  }
  if (quota.kind !== "subscription" || dailyRefusal.status !== 429) {
    return dailyRefusal;
  }

  const minuteRefusal = await checkOrganizationLimit(
    c,
    {
      windowMs: CLEF_DECISIONS_CREDENTIAL_LIMIT.windowMs,
      maxRequests: quota.rpm,
      keyGenerator: () => `${dailyKey}:subscription-minute`,
    },
    "subscription-minute",
  );
  if (minuteRefusal) return minuteRefusal;
  c.header(SCOPE_HEADER, "subscription-minute");
  return null;
}

const app = new Hono<AppEnv>();

app.post("/", moneyRateLimit(CLEF_DECISIONS_CREDENTIAL_LIMIT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    c.header("cache-control", "no-store");
    const decoded = await decodeRequestJson(c.req);
    if (!decoded.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const request = decoded.value as ClefDecisionRequest;
    const problem =
      typeof request === "object" && request !== null
        ? clefDecisionRequestProblem(request)
        : "kind";
    if (problem) {
      return c.json({ error: "Invalid decision request", field: problem }, 400);
    }
    const binding = c.env.AI;
    if (c.env.CLEF_DECISIONS_ENABLED !== "true" || !binding) {
      return c.json({ status: "unavailable", reason: "disabled" }, 503);
    }
    const limited = await admitOrganizationDecision(c, user.organization_id);
    if (limited) return limited;
    try {
      return c.json(
        await runClefDecision(
          binding,
          resolveClefModel(c.env.CLEF_DECISION_MODEL),
          request,
        ),
      );
    } catch (error) {
      if (!(error instanceof ClefDecisionError)) throw error;
      // error-policy:J2 the documented unavailable answer; the code is logged, never the request.
      logger.warn("[Decisions] Clef unavailable", { code: error.code });
      return c.json({ status: "unavailable", reason: "provider_error" }, 503);
    }
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
