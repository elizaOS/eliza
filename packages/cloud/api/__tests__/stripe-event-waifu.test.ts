/** Exercises the Stripe queue callback for agent credit top-ups. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api/cloud-worker-errors";

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
const containerBackedTargetRejectionReason =
  "agent_job_target_not_container_backed";
const settleLegacy = mock(async () => ({
  organizationId: "agent-org",
  initiatedByUserId: "agent-user",
  purchaseType: "custom_amount" as const,
  creditsToGrant: "5.000000",
  alreadyApplied: false,
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
    markPaid: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {
    processPurchase: mock(async () => ({
      creditsAdded: 5,
      platformOffset: 0,
      creatorEarnings: 0,
      newBalance: 5,
    })),
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
  CONTAINER_BACKED_TARGET_REJECTION_REASON:
    containerBackedTargetRejectionReason,
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
mock.module("@/lib/services/stripe-checkout-orders", () => ({
  stripeCheckoutOrdersService: { settleLegacy },
}));
mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({}),
}));

const { processStripeEvent } = await import("../src/queue/stripe-event");

function agentTopUpDelivery(eventId: string, attempts = 1) {
  return {
    attempts,
    body: {
      kind: "stripe.event",
      eventId,
      eventType: "checkout.session.completed",
      paymentIntentId,
      receivedAt: Date.now(),
      event: {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: `cs_${eventId}`,
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
  } as unknown as Parameters<typeof processStripeEvent>[0];
}

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
    settleLegacy.mockClear();
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
    expect(settleLegacy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "agent-org",
        initiatedByUserId: "agent-user",
        paymentIntentId,
        checkoutSessionId: "cs_agent_paid",
      }),
    );
    expect(addCredits).not.toHaveBeenCalled();
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
      eventId: `stripe:evt_agent_topup:credits.topped_up:${agentId}:settled`,
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
    expect(settleLegacy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "agent-org",
        initiatedByUserId: "agent-user",
        paymentIntentId: "pi_org_topup",
        checkoutSessionId: "cs_org_paid",
      }),
    );
    expect(addCredits).not.toHaveBeenCalled();
    expect(webhookFetch).not.toHaveBeenCalled();
    expect(enqueueAgentRestartOnce).not.toHaveBeenCalled();
    expect(triggerImmediate).not.toHaveBeenCalled();
  });

  test("retries the restart enqueue for duplicate agent top-up deliveries", async () => {
    settleLegacy.mockResolvedValueOnce({
      organizationId: "agent-org",
      initiatedByUserId: "agent-user",
      purchaseType: "custom_amount",
      creditsToGrant: "5.000000",
      alreadyApplied: true,
      newBalance: 5,
    });

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

  test("acks a Shared-like locked tier rejection without nudging compute", async () => {
    enqueueAgentRestartOnce.mockRejectedValueOnce(
      new ApiError(
        409,
        "session_not_ready",
        "Agent job requires a container-backed tier",
        {
          reason: containerBackedTargetRejectionReason,
          jobType: "agent_restart",
        },
      ),
    );

    expect(
      await processStripeEvent(agentTopUpDelivery("evt_shared_topup")),
    ).toBe("ack");
    expect(settleLegacy).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRestartOnce).toHaveBeenCalledWith({
      agentId,
      organizationId: "agent-org",
      userId: "agent-user",
    });
    expect(triggerImmediate).not.toHaveBeenCalled();
    expect(calculateRevenueSplits).toHaveBeenCalledTimes(1);
    expect(createInvoice).toHaveBeenCalledTimes(1);
  });

  test("retries an unrelated restart admission failure", async () => {
    enqueueAgentRestartOnce.mockRejectedValueOnce(
      new ApiError(
        409,
        "session_not_ready",
        "Another lifecycle job is active",
        {
          reason: "exclusive_lifecycle_conflict",
          jobType: "agent_restart",
        },
      ),
    );

    expect(
      await processStripeEvent(agentTopUpDelivery("evt_restart_conflict")),
    ).toBe("retry");
    expect(settleLegacy).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRestartOnce).toHaveBeenCalledTimes(1);
    expect(triggerImmediate).not.toHaveBeenCalled();
    expect(calculateRevenueSplits).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
  });
});
