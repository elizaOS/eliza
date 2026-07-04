/**
 * POST /api/v1/embeddings
 *
 * OpenAI-compatible embeddings endpoint. Routes through the AI SDK + AI
 * Gateway with credit reservation/bill-and-record on the SDK's reported
 * usage.
 */

import { APICallError, embed, embedMany, RetryError } from "ai";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { enforceOrgRateLimit } from "@/lib/middleware/rate-limit";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
  normalizeModelName,
} from "@/lib/pricing";
import {
  getAiProviderConfigurationError,
  getTextEmbeddingModel,
  hasTextEmbeddingProviderConfigured,
  resolveEmbeddingProviderSource,
} from "@/lib/providers/language-model";
import {
  billUsage,
  InsufficientCreditsError,
  reserveCredits,
} from "@/lib/services/ai-billing";
import { resolveInferenceAuthContext } from "@/lib/services/inference-auth-context";
import {
  createOptimisticDebitSettler,
  getGateBalanceUsd,
  isOptimisticBackstopAvailable,
  isOptimisticBillingEnabled,
  isOptimisticEligible,
  resolveSafeBalanceThresholdUsd,
  writePendingInferenceCharge,
} from "@/lib/services/inference-billing-fast-path";
import {
  admitInferenceChargeViaLedger,
  createLedgerDebitSettler,
  resolveInferenceBillingLedger,
} from "@/lib/services/inference-billing-ledger";
import { usageService } from "@/lib/services/usage";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface EmbeddingsRequest {
  input: string | string[];
  model: string;
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

const app = new Hono<AppEnv>();

// Embeddings use RELAXED to match chat completions and responses — embeddings
// are typically issued in batches for RAG ingestion.
app.use("*", rateLimit(RateLimitPresets.RELAXED));

app.post("/", async (c) => {
  // Hoisted so the catch can release the upfront credit hold when a provider
  // failure (e.g. the embedding provider's 429/5xx) throws AFTER the reservation
  // was taken but BEFORE billing reconciled it. Without this the ~1.5x hold is
  // debited permanently — a money leak on the paid inference path. Mirrors the
  // /v1/chat/completions settler (idempotent, first-call-wins).
  let settleReservation:
    | ReturnType<typeof createCreditReservationSettler>
    | undefined;
  // True once settleBilling() has taken ownership of settling/releasing the
  // reservation, so the outer catch never double-applies a release.
  let billed = false;
  try {
    // Resolve auth (+ org + moderation) in a SINGLE cache read for API-key
    // inference requests (#9899) — the same fast-path as /v1/chat/completions.
    // This route is on the agent reply hot path: the always-on
    // `relevant-conversations` recall provider embeds the incoming message on
    // EVERY memory-backed turn (blocking Stage-1), so the old per-request
    // auth+org+moderation DB chain added ~1.5s+ to every reply. Non-API-key /
    // cache-unavailable requests fall to the authoritative slow path verbatim.
    let user: { id: string; organization_id: string };
    let apiKeyId: string | null;
    const resolution = await resolveInferenceAuthContext(c.req.raw);
    if (resolution.kind === "suspended") {
      return c.json(
        {
          error: {
            message:
              "Your account has been suspended due to policy violations.",
            type: "account_suspended",
            code: "moderation_violation",
          },
        },
        403,
      );
    }
    if (resolution.kind === "authorized") {
      user = {
        id: resolution.ctx.userId,
        organization_id: resolution.ctx.orgId,
      };
      apiKeyId = resolution.ctx.apiKeyId;
    } else {
      user = await requireUserOrApiKeyWithOrg(c);
      // `requireUserOrApiKeyWithOrg` already validated the API key (when present)
      // and exposed its id on the request context — reuse it instead of doing a
      // second DB lookup per request.
      apiKeyId = c.get("apiKeyId") ?? null;
    }

    if (user.organization_id) {
      const orgRateLimited = await enforceOrgRateLimit(
        user.organization_id,
        "embeddings",
      );
      if (orgRateLimited) return orgRateLimited;
    }

    // Guard a malformed/empty body to a 400 instead of a 500 (mirrors the agents
    // routes). An unguarded parse throws a SyntaxError that failureResponse maps
    // to 500 on this always-on agent-recall hot path.
    const request = (await c.req
      .json()
      .catch(() => null)) as EmbeddingsRequest | null;

    if (!request?.model || !request.input) {
      return c.json(
        {
          error: {
            message: "Missing required fields: model and input",
            type: "invalid_request_error",
            param: !request?.model ? "model" : "input",
            code: "missing_required_parameter",
          },
        },
        400,
      );
    }

    if (Array.isArray(request.input) && request.input.length === 0) {
      return c.json(
        {
          error: {
            message: "input array cannot be empty",
            type: "invalid_request_error",
            param: "input",
            code: "invalid_value",
          },
        },
        400,
      );
    }

    if (
      typeof request.input === "string" &&
      request.input.trim().length === 0
    ) {
      return c.json(
        {
          error: {
            message: "input string cannot be empty",
            type: "invalid_request_error",
            param: "input",
            code: "invalid_value",
          },
        },
        400,
      );
    }

    const model = request.model;
    const provider = getProviderFromModel(model);
    const normalizedModel = normalizeModelName(model);
    const billingSource = resolveEmbeddingProviderSource() ?? undefined;

    if (!hasTextEmbeddingProviderConfigured()) {
      return c.json(
        {
          error: {
            message: getAiProviderConfigurationError(),
            type: "service_unavailable",
            code: "ai_not_configured",
          },
        },
        503,
      );
    }

    const inputText = Array.isArray(request.input)
      ? request.input.join(" ")
      : request.input;
    const estimatedInputTokens = estimateTokens(inputText);

    // #9899 Tier-2 optimistic billing on the embeddings recall hot path. When
    // enabled AND this org's balance comfortably clears SAFE_BALANCE_THRESHOLD,
    // SKIP the synchronous reserve write (~0.8-1.7s of serial credit DB on every
    // memory-backed reply) and defer the ACTUAL-cost debit to the post-response
    // settle, backed by a durable pending-charge. Gated + fail-SAFE: flag off
    // / null org / low balance / cache down / non-durable backstop all fall
    // through to the synchronous reserve below, VERBATIM (same try/catch/402 as
    // today). On the optimistic path the reservation's `reconcile` IS the
    // actual-cost debit, and settleBilling invokes it through the single
    // first-call-wins settler.
    // #11588: server-generate the billing requestId — it feeds the affiliate
    // dedupe sourceId and must not be client-controllable (see the fuller note
    // in v1/chat/completions/route.ts).
    const requestId = crypto.randomUUID();
    const orgId = user.organization_id;
    // Read once, up front: the affiliate code must reach BOTH the reserve
    // (#12017 — so the upfront hold covers the affiliate markup delta,
    // fail-closed, exactly like /v1/messages and /v1/chat/completions) and the
    // deferred billUsage below. Reserving WITHOUT it left the hold at
    // base+platform only, so an attacker-set markup (up to 1000%) settled as an
    // uncollectable overage while the affiliate was still credited cashable
    // earnings — minting money the platform never collected (#11972 residual).
    const affiliateCode = c.req.header("X-Affiliate-Code") ?? null;
    let reservation: Awaited<ReturnType<typeof reserveCredits>> | undefined;
    let optimisticReady = false;

    // Durable backstop selected by INFERENCE_BILLING_LEDGER (see chat route). The
    // DB ledger's atomic admission is itself the gate and needs no writable cache.
    const optimisticBillingEnabled = isOptimisticBillingEnabled();
    const useDbLedger =
      !!orgId &&
      optimisticBillingEnabled &&
      resolveInferenceBillingLedger() === "db";

    if (useDbLedger) {
      const { totalCost: backstopEstimateUsd } = await calculateCost(
        model,
        provider,
        estimatedInputTokens,
        0,
        billingSource,
      );
      const admission = await admitInferenceChargeViaLedger({
        charge: {
          requestId,
          organizationId: orgId,
          userId: user.id,
          apiKeyId,
          model,
          provider,
          billingSource: billingSource ?? "",
        },
        estimatedCostUsd: backstopEstimateUsd,
        thresholdUsd: resolveSafeBalanceThresholdUsd(),
      });
      if (admission.admitted) {
        const ledgerSettler = createLedgerDebitSettler({
          requestId,
          organizationId: orgId,
          userId: user.id,
          apiKeyId,
          model,
          provider,
          billingSource: billingSource ?? "",
        });
        reservation = {
          reservedAmount: 0,
          reservationTransactionId: null,
          reconcile: async (actualCost: number) => {
            await ledgerSettler(actualCost);
          },
        };
        optimisticReady = true;
      }
    }

    if (
      !optimisticReady &&
      orgId &&
      optimisticBillingEnabled &&
      !useDbLedger &&
      isOptimisticBackstopAvailable()
    ) {
      // Embeddings cost ~$0, so SAFE_BALANCE_THRESHOLD is the real guard: the
      // gate estimate is 0 (balance must still clear the threshold).
      // resolveSafeBalanceThresholdUsd() returns +Infinity when unset/invalid →
      // isOptimisticEligible returns false → no org is fast-pathed on misconfig.
      const balanceUsd = await getGateBalanceUsd(orgId);
      const useOptimistic = isOptimisticEligible({
        enabled: true,
        useAppCredits: false,
        balanceUsd,
        thresholdUsd: resolveSafeBalanceThresholdUsd(),
        estimatedCostUsd: 0,
      });
      if (useOptimistic) {
        // Durability gate: take the optimistic path ONLY if the pending-charge
        // backstop actually persisted. The inline debit only fires when it
        // CLAIMS this entry (getAndDelete) at settle time, so a missing entry
        // would mean free inference — fall back to the synchronous reserve
        // instead. The backstop records the REAL input-token cost estimate (NOT
        // 0): in steady state the inline settler charges the actual cost, but a
        // DROPPED settle (isolate eviction) falls to the cron sweep, which then
        // recovers THIS estimate — so a bulk embedMany ingestion batch can't leak
        // its whole cost. Embeddings have no output tokens and input tokens are
        // known up front, so the estimate is accurate (no blind-over-bill risk),
        // mirroring the chat path's `estimatedCostUsd = totalCost` backstop.
        const { totalCost: backstopEstimateUsd } = await calculateCost(
          model,
          provider,
          estimatedInputTokens,
          0,
          billingSource,
        );
        const persisted = await writePendingInferenceCharge(
          {
            requestId,
            organizationId: orgId,
            userId: user.id,
            apiKeyId,
            model,
            provider,
            billingSource: billingSource ?? "",
            estimatedCostUsd: backstopEstimateUsd,
          },
          Date.now(),
        );
        if (persisted) {
          // Build a reservation whose `reconcile` IS the optimistic debit
          // settler. We deliberately do NOT use
          // creditsService.createAnonymousReservation() here — its reconcile is
          // a no-op (`async () => {}`), which would make settleReservation charge
          // NOTHING (free embeddings — the known trap). When settleBilling calls
          // settleReservation(totalCost), the settler atomically claims the
          // pending backstop (so the sweep can't also charge) and debits the
          // ACTUAL marked-up cost via deductCredits.
          const optimisticSettler = createOptimisticDebitSettler({
            requestId,
            organizationId: orgId,
            userId: user.id,
            model,
            provider,
            billingSource: billingSource ?? "",
          });
          reservation = {
            reservedAmount: 0,
            reservationTransactionId: null,
            reconcile: async (actualCost: number) => {
              await optimisticSettler(actualCost);
            },
          };
          optimisticReady = true;
        } else {
          logger.warn(
            "[Embeddings] optimistic backstop not durable; using synchronous reserve",
            { requestId, organizationId: orgId },
          );
        }
      }
    }

    if (!optimisticReady) {
      // SAFE PATH — byte-identical to today: synchronous reserve up front + a
      // clean 402 on insufficient balance. Also the path for flag-off, null-org,
      // low-balance, and cache-down requests.
      try {
        reservation = await reserveCredits(
          {
            organizationId: user.organization_id,
            userId: user.id,
            model,
            provider,
            billingSource,
            // #12017: fold the affiliate markup into the hold
            // (estimatedCostMultiplier inside reserveCredits) so the later
            // affiliate credit is always backed by collected money.
            affiliateCode,
          },
          estimatedInputTokens,
          0,
        );
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return c.json(
            {
              error: {
                message: `Insufficient credits. Required: $${error.required.toFixed(4)}`,
                type: "insufficient_quota",
                code: "insufficient_balance",
              },
            },
            402,
          );
        }
        throw error;
      }
    }

    // Idempotent settler over whatever reservation we built. The success path
    // settles the actual cost; failure paths release to zero. For the optimistic
    // reservation, settleReservation(0) → reconcile(0) → optimisticSettler(0):
    // it claims (removes) the pending entry and debits nothing.
    if (!reservation) {
      // Unreachable: every branch above assigns `reservation` or returns/throws.
      // Narrows the `| undefined` for the settler type below.
      throw new Error("[Embeddings] credit reservation missing");
    }
    settleReservation = createCreditReservationSettler(reservation);
    // #12017 residual (leg 2, missed by #12047's reserve fix): a view of the
    // reservation whose reconcile routes through the SAME first-call-wins
    // settler, handed to billUsage so the #11976 collected-earnings clamp is
    // live on this path too — the affiliate is paid from the COLLECTED markup
    // only (0 on an `uncollected_overage`), even when the actual token count
    // blows past the estimated reserve (estimateTokens is chars/4; CJK/emoji
    // inputs tokenize at >1.5x that, defeating the buffered hold). The settler
    // stays the single reconcile owner (#10557): billUsage settles through it,
    // and the explicit settle in settleBilling below becomes an idempotent
    // no-op.
    const settleOwner = settleReservation;
    const settlerBackedReservation = {
      ...reservation,
      reconcile: async (actualCost: number) =>
        (await settleOwner(actualCost)) ?? undefined,
    };

    logger.info("[Embeddings] Request", {
      model,
      inputCount: Array.isArray(request.input) ? request.input.length : 1,
      estimatedTokens: estimatedInputTokens,
    });

    let embeddings: number[][];
    let actualTokens = 0;

    if (Array.isArray(request.input)) {
      const result = await embedMany({
        model: getTextEmbeddingModel(model),
        values: request.input,
      });
      embeddings = result.embeddings;
      actualTokens = result.usage?.tokens || estimatedInputTokens;
    } else {
      const result = await embed({
        model: getTextEmbeddingModel(model),
        value: request.input,
      });
      embeddings = [result.embedding];
      actualTokens = result.usage?.tokens || estimatedInputTokens;
    }

    // Defer billing off the response path: reconciliation + usage recording add
    // serial DB round-trips that need not block the vector return. We still RUN
    // billUsage + settle the reservation, just after the response is sent via
    // waitUntil. The terminal insufficient-credits guard already fired above
    // (reserveCredits), so a caller with no balance was rejected before embedding;
    // the only residual risk is an under-bill if the Worker dies before the
    // deferred task completes — an accepted trade-off for this route. The settler
    // prevents double-settlement inside the task.
    const settleBilling = async () => {
      try {
        // #10557: `settleReservation` is the SINGLE idempotent reconcile owner
        // (mirrors /v1/messages and /v1/chat/completions). billUsage is handed
        // the settler-backed reservation VIEW (never the raw reservation), so
        // its internal reconcile also flows through the first-call-wins settler
        // — no double-settlement is possible with the explicit settle below or
        // with the catch's settleReservation(0). Routing the reconcile through
        // billUsage (before its affiliate-earnings write) is what arms the
        // #11976 collected-earnings clamp on this path (#12017 leg 2).
        const billing = await billUsage(
          {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId,
            model,
            provider,
            billingSource,
            // #11588: the server-generated requestId keys the affiliate
            // earnings dedupe sourceId (`ai_billing:usage:<requestId>`);
            // without it billUsage falls back to a legacy-random sourceId and
            // the dedupe can never fire.
            requestId,
            // Affiliate revenue-share: when the calling app sets X-Affiliate-Code,
            // activate the existing billUsage affiliate branch (same as /v1/messages).
            affiliateCode,
          },
          { inputTokens: actualTokens, outputTokens: 0 },
          settlerBackedReservation,
        );

        // Safety-net settle: billUsage already reconciled the actual cost
        // through the settler, so this is an idempotent no-op that only fires
        // if billUsage ever returns without reconciling.
        await settleReservation?.(billing.totalCost);

        logger.info("[Embeddings] Complete", {
          model,
          actualTokens,
          totalCost: billing.totalCost,
        });

        await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKeyId,
          type: "embeddings",
          model: normalizedModel,
          provider,
          input_tokens: actualTokens,
          output_tokens: 0,
          input_cost: String(billing.inputCost),
          output_cost: String(0),
          is_successful: true,
        });
      } catch (err) {
        // billUsage / calculateCost / affiliate lookup threw before the hold was
        // reconciled → release it. Idempotent: a no-op if we already settled the
        // actual cost above. Rethrow so the waitUntil .catch logs it.
        await settleReservation?.(0);
        throw err;
      }
    };

    // Past this point the deferred settleBilling owns the hold (it settles the
    // actual cost on success and releases it on its own failure), so the outer
    // catch must NOT also release it.
    billed = true;
    const billedPromise = settleBilling().catch((err) => {
      logger.error("[Embeddings] Failed to settle billing", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    if (typeof c.executionCtx?.waitUntil === "function") {
      c.executionCtx.waitUntil(billedPromise);
    }

    return c.json({
      object: "list",
      data: embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding,
        index,
      })),
      model,
      usage: {
        prompt_tokens: actualTokens,
        total_tokens: actualTokens,
      },
    });
  } catch (error) {
    // Release the upfront credit hold on any failure that landed here before
    // billing took over (e.g. the embedding provider threw 429/5xx). Guarded by
    // `billed` so the success path's reconcile is never double-applied, and by
    // `settleReservation` so a failure BEFORE reserve() (settler undefined) is a
    // no-op. The settler is idempotent, so this can never over-refund.
    if (!billed && settleReservation) {
      try {
        await settleReservation(0);
        logger.info("[Embeddings] Reservation released after provider error");
      } catch (reconcileError) {
        logger.error("[Embeddings] Failed to release reservation after error", {
          error:
            reconcileError instanceof Error
              ? reconcileError.message
              : String(reconcileError),
        });
      }
    }

    logger.error("[Embeddings] Error", {
      error: error instanceof Error ? error.message : String(error),
    });

    // Upstream provider failures (invalid provider key, provider 5xx) must not
    // surface as 401/403 to the caller — the user authenticated to us fine.
    const providerError = RetryError.isInstance(error)
      ? error.lastError
      : error;
    if (APICallError.isInstance(providerError)) {
      const status =
        providerError.statusCode === 429
          ? 429
          : providerError.statusCode === 402
            ? 402
            : 503;
      return c.json(
        {
          error: {
            message: providerError.message || "Upstream provider error",
            type: status === 429 ? "rate_limit_error" : "service_unavailable",
            code: status === 429 ? "rate_limit_exceeded" : "provider_error",
          },
        },
        status,
      );
    }

    return failureResponse(c, error);
  }
});

export default app;
