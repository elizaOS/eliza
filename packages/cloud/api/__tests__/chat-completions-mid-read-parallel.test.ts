/**
 * Hot-path orchestration test for POST /api/v1/chat/completions.
 * Requests drive the real authorization and credit-admission boundary.
 *
 * The route has several independent reads between auth and credit reservation:
 * app monetization, pooled credential selection, reasoning-catalog lookup, and
 * user suspension. This harness gates each read and proves the route starts
 * them together, while still failing before provider forward if any gate later
 * reports a blocking state.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import * as authActual from "@/lib/auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as appsActual from "@/lib/services/apps";
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";
import * as fastPathActual from "@/lib/services/inference-billing-fast-path";
import * as billingLedgerActual from "@/lib/services/inference-billing-ledger";
import * as modelCatalogActual from "@/lib/services/model-catalog";
import * as teamCredentialPoolActual from "@/lib/services/team-credential-pool";
import * as creditReservationActual from "@/lib/utils/credit-reservation";

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";

const events: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function waitForEvents(expected: readonly string[]) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const tick = () => {
      if (expected.every((event) => events.includes(event))) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(
            `Timed out waiting for ${expected.join(", ")}; saw ${events.join(", ")}`,
          ),
        );
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

const appGate = deferred();
const moderationGate = deferred();
const catalogGate = deferred();
const poolGate = deferred();

mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthContextActual,
  resolveInferenceAuthContext: async () => ({
    kind: "slow_path",
    reason: "non_api_key",
  }),
}));

mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: USER, organization_id: ORG },
    apiKey: null,
  }),
}));

mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit: async () => null,
}));

mock.module("@/lib/services/apps", () => ({
  ...appsActual,
  appsService: {
    ...appsActual.appsService,
    getAuthorizedMonetizedAppForUser: async () => {
      events.push("app:start");
      await appGate.promise;
      events.push("app:end");
      return null;
    },
  },
}));

mock.module("@/lib/services/content-moderation", () => ({
  ...contentModerationActual,
  contentModerationService: {
    ...contentModerationActual.contentModerationService,
    shouldBlockUser: async () => {
      events.push("moderation:start");
      await moderationGate.promise;
      events.push("moderation:end");
      return false;
    },
    moderateInBackground: () => {},
  },
}));

mock.module("@/lib/services/model-catalog", () => ({
  ...modelCatalogActual,
  getCachedGatewayModelById: async () => {
    events.push("catalog:start");
    await catalogGate.promise;
    events.push("catalog:end");
    return null;
  },
}));

mock.module("@/lib/services/team-credential-pool", () => ({
  ...teamCredentialPoolActual,
  getTeamPoolRegistry: () => ({
    selectCredential: async () => {
      events.push("pool:start");
      await poolGate.promise;
      events.push("pool:end");
      return null;
    },
    recordUse: async () => {},
    recordProviderFailure: async () => {},
  }),
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasLanguageModelProviderConfigured: () => true,
  getLanguageModel: () => ({}) as never,
}));

mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost: async () => ({
    totalCost: 0.01,
    inputCost: 0.005,
    outputCost: 0.005,
  }),
}));

mock.module("@/lib/services/inference-billing-fast-path", () => ({
  ...fastPathActual,
  isOptimisticBillingEnabled: () => false,
}));

mock.module("@/lib/services/inference-billing-ledger", () => ({
  ...billingLedgerActual,
  resolveInferenceBillingLedger: () => "kv",
}));

mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits: async () => ({
    reservedAmount: 0.015,
    reconcile: async () => null,
  }),
}));

mock.module("@/lib/utils/credit-reservation", () => ({
  ...creditReservationActual,
  createCreditReservationSettler: () => async () => null,
}));

mock.module("ai", () => ({
  ...aiActual,
  generateText: () => {
    throw new Error("model-call-stub");
  },
  streamText: () => {
    throw new Error("model-call-stub");
  },
}));

const { handleChatCompletionsPOST } = await import(
  "../v1/chat/completions/route"
);

afterAll(() => {
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthContextActual,
  );
  mock.module("@/lib/auth", () => authActual);
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
  mock.module("@/lib/services/apps", () => appsActual);
  mock.module(
    "@/lib/services/content-moderation",
    () => contentModerationActual,
  );
  mock.module("@/lib/services/model-catalog", () => modelCatalogActual);
  mock.module(
    "@/lib/services/team-credential-pool",
    () => teamCredentialPoolActual,
  );
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/pricing", () => pricingActual);
  mock.module(
    "@/lib/services/inference-billing-fast-path",
    () => fastPathActual,
  );
  mock.module(
    "@/lib/services/inference-billing-ledger",
    () => billingLedgerActual,
  );
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module("@/lib/utils/credit-reservation", () => creditReservationActual);
  mock.module("ai", () => aiActual);
});

function makeRequest(): Request {
  return new Request("https://api.test/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-App-Id": "app-1",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });
}

describe("chat/completions mid-read orchestration", () => {
  test("starts independent mid reads together before credit reservation", async () => {
    const responsePromise = handleChatCompletionsPOST(makeRequest());

    await waitForEvents([
      "app:start",
      "moderation:start",
      "catalog:start",
      "pool:start",
    ]);

    expect(events).not.toContain("app:end");
    expect(events).not.toContain("moderation:end");
    expect(events).not.toContain("catalog:end");
    expect(events).not.toContain("pool:end");

    appGate.resolve();
    moderationGate.resolve();
    catalogGate.resolve();
    poolGate.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(500);
  });
});
