/** Exercises the Stripe queue callback for agent credit top-ups. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const agentId = "123e4567-e89b-12d3-a456-426614174000";
const paymentIntentId = "pi_agent_topup";
const webhookFetch = mock(async () => Response.json({ ok: true }));
const getTransactionByStripePaymentIntent = mock(
  async (): Promise<{ id: string } | null> => null,
);
const addCredits = mock(async () => ({ newBalance: 8.25 }));
const getByStripeInvoiceId = mock(async () => null);
const createInvoice = mock(async () => undefined);
const calculateRevenueSplits = mock(async () => ({ splits: [] }));
const enqueueAgentRestartOnce = mock(async () => ({ jobId: "job-restart" }));
const triggerImmediate = mock(async () => undefined);
const markAppChargePaid = mock(async () => ({
  disposition: "settled" as const,
  callback: null,
}));
const processAppPurchase = mock(async () => ({
  creditsAdded: 5,
  platformOffset: 0,
  creatorEarnings: 0,
  newBalance: 5,
}));

function dbChain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
}

const dbRead = {
  select: mock(() =>
    dbChain([
      {
        id: agentId,
        organizationId: "agent-org",
        agent_config: {
          tokenContractAddress: "0x0000000000000000000000000000000000000009",
          chain: "bsc",
          chainId: 56,
          account: {
            primaryWalletAddress: "0x0000000000000000000000000000000000000001",
            walletKeyRef: "steward:waifu-agent",
          },
          webhookUrl:
            "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
          webhookSecret: "test-webhook-secret",
        },
        status: "suspended",
        billing_status: "depleted",
      },
    ]),
  ),
};

mock.module("@/db/helpers", () => ({ dbRead }));
mock.module("@/db/repositories/organizations", () => ({
  organizationsRepository: {
    findById: mock(async () => ({ name: "Agent Org" })),
  },
}));
mock.module("@/db/repositories/users", () => ({
  usersRepository: {
    findById: mock(async () => ({ name: "Agent User" })),
  },
}));
mock.module("@/lib/security/safe-fetch", () => ({
  safeFetch: webhookFetch,
}));
mock.module("@/lib/services/app-charge-callbacks", () => ({
  appChargeCallbacksService: {},
}));
mock.module("@/lib/services/app-charge-settlement", () => ({
  appChargeSettlementService: {
    markPaid: markAppChargePaid,
  },
}));
mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {
    processPurchase: processAppPurchase,
  },
}));
mock.module("@/lib/services/auto-top-up", () => ({
  autoTopUpService: {
    reconcileSucceededPaymentIntent: mock(async () => ({
      disposition: "settled",
      result: { status: "succeeded" },
    })),
  },
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: {
    getTransactionByStripePaymentIntent,
    addCredits,
  },
}));
mock.module("@/lib/services/discord", () => ({
  discordService: {
    logPaymentReceived: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/invoices", () => ({
  invoicesService: {
    getByStripeInvoiceId,
    create: createInvoice,
  },
}));
mock.module("@/lib/services/org-rate-limits", () => ({
  invalidateOrgTierCache: mock(async () => undefined),
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentRestartOnce,
    triggerImmediate,
  },
}));
mock.module("@/lib/services/redeemable-earnings", () => ({
  redeemableEarningsService: {
    addEarnings: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/referrals", () => ({
  referralsService: {
    calculateRevenueSplits,
  },
}));
mock.module("@/lib/security/safe-fetch", () => ({
  safeFetch: webhookFetch,
}));
mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({}),
}));

const { processStripeEvent } = await import("../src/queue/stripe-event");

describe("stripe checkout queue waifu top-up callback", () => {
  beforeEach(() => {
    dbRead.select.mockClear();
    getTransactionByStripePaymentIntent.mockClear();
    addCredits.mockClear();
    getByStripeInvoiceId.mockClear();
    createInvoice.mockClear();
    calculateRevenueSplits.mockClear();
    webhookFetch.mockClear();
    enqueueAgentRestartOnce.mockClear();
    triggerImmediate.mockClear();
    markAppChargePaid.mockClear();
    processAppPurchase.mockClear();
    getTransactionByStripePaymentIntent.mockImplementation(async () => null);
  });

  test("emits token and wallet context for agent credit top-ups", async () => {
    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_agent_topup",
        eventType: "checkout.session.completed",
        paymentIntentId,
        receivedAt: Date.now(),
        event: {
          id: "evt_agent_topup",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_agent_paid",
              payment_status: "paid",
              amount_total: 500,
              currency: "usd",
              customer: "cus_agent",
              payment_intent: paymentIntentId,
              metadata: {
                organization_id: "agent-org",
                user_id: "agent-user",
                credits: "5.00",
                type: "custom_amount",
                agent_id: agentId,
              },
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(addCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "agent-org",
        amount: 5,
        stripePaymentIntentId: paymentIntentId,
        metadata: expect.objectContaining({
          agent_id: agentId,
          session_id: "cs_agent_paid",
        }),
      }),
    );
    expect(webhookFetch).toHaveBeenCalledTimes(1);
    const [url, init] = (webhookFetch.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
    );
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      event: "credits.topped_up",
      eventId: `stripe:evt_agent_topup:credits.topped_up:${agentId}`,
      elizaCloudAgentId: agentId,
      organizationId: "agent-org",
      tokenContractAddress: "0x0000000000000000000000000000000000000009",
      tokenAddress: "0x0000000000000000000000000000000000000009",
      tokenChain: "bsc",
      chain: "bsc",
      chainId: 56,
      primaryWalletAddress: "0x0000000000000000000000000000000000000001",
      walletKeyRef: "steward:waifu-agent",
      amountUsd: 5,
      paymentIntentId,
      sessionId: "cs_agent_paid",
    });
    expect(
      ((init as RequestInit).headers as Record<string, string>)[
        "X-Waifu-Webhook-Signature"
      ],
    ).toStartWith("sha256=");
    expect(enqueueAgentRestartOnce).toHaveBeenCalledWith({
      agentId,
      organizationId: "agent-org",
      userId: "agent-user",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });

  test("does not enqueue an agent restart for org-only credit top-ups", async () => {
    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_org_topup",
        eventType: "checkout.session.completed",
        paymentIntentId: "pi_org_topup",
        receivedAt: Date.now(),
        event: {
          id: "evt_org_topup",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_org_paid",
              payment_status: "paid",
              amount_total: 500,
              currency: "usd",
              customer: "cus_org",
              payment_intent: "pi_org_topup",
              metadata: {
                organization_id: "agent-org",
                user_id: "agent-user",
                credits: "5.00",
                type: "custom_amount",
              },
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(addCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "agent-org",
        amount: 5,
        stripePaymentIntentId: "pi_org_topup",
      }),
    );
    expect(webhookFetch).not.toHaveBeenCalled();
    expect(enqueueAgentRestartOnce).not.toHaveBeenCalled();
    expect(triggerImmediate).not.toHaveBeenCalled();
  });

  test("passes Stripe's authoritative currency and exact charge correlation to settlement", async () => {
    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_app_charge",
        eventType: "checkout.session.completed",
        paymentIntentId: "pi_app_charge",
        receivedAt: Date.now(),
        event: {
          id: "evt_app_charge",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_app_charge",
              payment_status: "paid",
              amount_total: 500,
              currency: "usd",
              payment_intent: "pi_app_charge",
              metadata: {
                organization_id: "payer-org",
                user_id: "payer-user",
                credits: "5.00",
                type: "app_credit_purchase",
                source: "miniapp_app",
                app_id: "app-five",
                charge_request_id: "charge-five",
              },
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(markAppChargePaid).toHaveBeenCalledTimes(1);
    expect(markAppChargePaid).toHaveBeenCalledWith({
      appId: "app-five",
      chargeRequestId: "charge-five",
      provider: "stripe",
      providerPaymentId: "pi_app_charge",
      amountUsd: 5,
      currency: "usd",
      payerUserId: "payer-user",
      payerOrganizationId: "payer-org",
      metadata: { stripe_checkout_session_id: "cs_app_charge" },
    });
  });

  test("rejects app checkout metadata that disagrees with Stripe's settled amount", async () => {
    const result = await processStripeEvent({
      attempts: 1,
      body: {
        kind: "stripe.event",
        eventId: "evt_app_charge_mismatch",
        eventType: "checkout.session.completed",
        paymentIntentId: "pi_app_charge_mismatch",
        receivedAt: Date.now(),
        event: {
          id: "evt_app_charge_mismatch",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_app_charge_mismatch",
              payment_status: "paid",
              amount_total: 500,
              currency: "usd",
              payment_intent: "pi_app_charge_mismatch",
              metadata: {
                organization_id: "payer-org",
                user_id: "payer-user",
                credits: "499.00",
                source: "miniapp_app",
                app_id: "app-five",
                charge_request_id: "charge-five",
              },
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(processAppPurchase).not.toHaveBeenCalled();
    expect(markAppChargePaid).not.toHaveBeenCalled();
  });

  test("retries the restart enqueue for duplicate agent top-up deliveries", async () => {
    getTransactionByStripePaymentIntent.mockImplementationOnce(async () => ({
      id: "existing-credit",
    }));

    const result = await processStripeEvent({
      attempts: 2,
      body: {
        kind: "stripe.event",
        eventId: "evt_agent_topup_retry",
        eventType: "checkout.session.completed",
        paymentIntentId,
        receivedAt: Date.now(),
        event: {
          id: "evt_agent_topup_retry",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_agent_paid",
              payment_status: "paid",
              amount_total: 500,
              currency: "usd",
              customer: "cus_agent",
              payment_intent: paymentIntentId,
              metadata: {
                organization_id: "agent-org",
                user_id: "agent-user",
                credits: "5.00",
                type: "custom_amount",
                agent_id: agentId,
              },
            },
          },
        },
      },
    } as unknown as Parameters<typeof processStripeEvent>[0]);

    expect(result).toBe("ack");
    expect(addCredits).not.toHaveBeenCalled();
    expect(webhookFetch).toHaveBeenCalledTimes(1);
    const [, init] = (webhookFetch.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.eventId).toBe(
      `stripe:evt_agent_topup_retry:credits.topped_up:${agentId}:already_applied`,
    );
    expect(enqueueAgentRestartOnce).toHaveBeenCalledWith({
      agentId,
      organizationId: "agent-org",
      userId: "agent-user",
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });
});
