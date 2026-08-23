/**
 * Pins Blooio inbound-media enrichment at the trusted messaging route: the
 * additive mediaUrls schema (allowlist re-validation), the flag-off/disabled
 * path staying byte-identical to the current media-URL text, the flag-on
 * described turn, the admission contract — every ledger decision other than
 * a fresh claim (reuse, in flight, exhausted, prior failure) and a missing
 * decision keep the raw turn without a provider call — and the degrade
 * contract: a typed enrichment failure keeps the user's turn instead of
 * failing the delivery, and a dedicated-runtime turn bypasses pooled-key
 * vision entirely. Collaborators are mocked; the describe helper's real typed
 * errors drive the real enrichment orchestrator, and the admission ledger is
 * an in-memory fake whose decisions are the code under test at this layer
 * (the PGlite sibling proves the real ledger).
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { logger } from "@/lib/utils/logger";

let activeTarget: {
  id: string;
  status: "running";
  bridge_url: string;
} | null = null;
const resolvePersonalDelivery = mock(async () => ({
  userId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  dedicatedTarget: activeTarget,
  isNew: false,
  resolution: "single-query-repeat" as const,
}));
const sharedRestMessageSend = mock(async (..._args: unknown[]) => ({
  text: "hello from Eliza",
}));
const prewarmPersonalSharedAgentTurnCaches = mock(async () => undefined);
const findActivePersonalDedicatedTarget = mock(async () => activeTarget);
const bridge = mock(
  async (
    _agentId: string,
    _organizationId: string,
    _request: { params: { text: string } },
  ) => ({
    jsonrpc: "2.0" as const,
    id: "blooio:eliza-app:message-42",
    result: { text: "hello from Dedicated" },
  }),
);
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeExecutionCtx = {
  waitUntil: mock((_promise: Promise<unknown>) => undefined),
};

// Real typed errors + constants from the helper module; only the describe
// entrypoint itself is replaced so its call/throw contract stays authentic.
const {
  InboundMediaDescriptionError,
  InboundMediaVisionDisabledError,
  isInboundMediaVisionEnabled,
  MAX_INBOUND_MEDIA_IMAGES,
} = await import("@/lib/services/eliza-app/describe-inbound-media");
type LedgerAdmission =
  import("@/db/repositories/personal-shared-inbound-media").InboundMediaDescriptionAdmission;
type LedgerClaim =
  import("@/db/repositories/personal-shared-inbound-media").InboundMediaDescriptionClaim;
const LEDGER_CLAIM: LedgerClaim = {
  id: "00000000-0000-4000-8000-0000000000aa",
  claimToken: "00000000-0000-4000-8000-0000000000ab",
  attempt: 1,
};
const ledgerAdmit = mock(
  async (_input: unknown): Promise<LedgerAdmission> => ({
    kind: "claimed",
    claim: LEDGER_CLAIM,
  }),
);
const ledgerComplete = mock(
  async (_claim: LedgerClaim, _description: string) => true,
);
const ledgerFail = mock(async (_claim: LedgerClaim, _reason: string) => true);
const { isAllowedBlooioMediaUrl } = await import(
  "@/lib/services/eliza-app/blooio-media-allowlist"
);
const describeInboundImageMedia = mock(
  async (
    _env: Record<string, unknown>,
    _urls: readonly string[],
  ): Promise<string> => {
    throw new InboundMediaVisionDisabledError(
      "Inbound media vision is disabled for this deployment",
    );
  },
);

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: { resolvePersonalDelivery },
}));
const { sharedTurnServerTiming } = await import(
  "@/lib/services/shared-runtime/shared-rest-adapter"
);
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessageSend,
  sharedTurnServerTiming,
}));
mock.module("@/lib/services/shared-runtime/prewarm-shared-agent", () => ({
  prewarmPersonalSharedAgentTurnCaches,
}));
mock.module("@/lib/services/eliza-app/onboarding-chat", () => ({
  runOnboardingChat: mock(async () => ({
    loginUrl: "https://cloud-staging.eliza.app/get-started",
  })),
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget,
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate: async () => ({ allowed: true, balance: 10 }),
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: async () => ({ ok: true, required: false }),
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentResumeOnce: mock(async () => ({ created: true })),
    enqueueAgentWakeOnce: mock(async () => ({ created: true })),
    triggerImmediate: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    bridge,
    importCanonicalConversation: mock(async () => null),
  },
}));
mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  coordinateSharedHistory: mock(async () => []),
}));
mock.module("@/db/repositories/personal-shared-groups", () => ({
  personalSharedGroupsRepository: {
    issueClaim: mock(async () => undefined),
    consumeClaimAndBind: mock(async () => ({ status: "invalid" })),
    resolveBinding: mock(async () => null),
    setResponsePolicy: mock(async () => null),
    revokeBinding: mock(async () => false),
    applyMembershipChange: mock(async () => null),
    recordDeliveryReceipts: mock(async () => 0),
    hasDeliveryReceipt: mock(async () => false),
  },
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx: runtimeExecutionCtx,
  }),
}));
mock.module("@/lib/services/eliza-app/describe-inbound-media", () => ({
  describeInboundImageMedia,
  InboundMediaDescriptionError,
  InboundMediaVisionDisabledError,
  isInboundMediaVisionEnabled,
  MAX_INBOUND_MEDIA_IMAGES,
}));
mock.module("@/db/repositories/personal-shared-inbound-media", () => ({
  personalSharedInboundMediaRepository: {
    admit: ledgerAdmit,
    complete: ledgerComplete,
    fail: ledgerFail,
  },
}));

const { default: app } = await import("./route");
const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };

const MEDIA_URL = "https://media.blooio.com/files/photo-1.jpeg";
const RAW_MEDIA_MESSAGE = `[media: ${MEDIA_URL}]`;

function request(body: unknown, env: Record<string, unknown> = {}) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
        "x-eliza-trace-id": "11111111-1111-4111-8111-111111111111",
      },
      body: JSON.stringify(body),
    },
    {
      INTERNAL_SECRET: "test-secret",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
      ELIZA_APP_INBOUND_MEDIA_VISION: "true",
      ...env,
    } as never,
    executionCtx as never,
  );
}

function blooioDelivery(overrides: Record<string, unknown> = {}) {
  return {
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: "+15550001111",
    phoneNumber: "+15551234567",
    messageId: "blooio:eliza-app:message-42",
    message: RAW_MEDIA_MESSAGE,
    mediaUrls: [MEDIA_URL],
    ...overrides,
  };
}

function deliveredMessage(): string {
  expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
  return sharedRestMessageSend.mock.calls[0]?.[2] as string;
}

function deliveredCapabilityText(): unknown {
  expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
  return sharedRestMessageSend.mock.calls[0]?.[9];
}

describe("blooio inbound media enrichment at the messaging route", () => {
  beforeEach(() => {
    activeTarget = null;
    resolvePersonalDelivery.mockClear();
    sharedRestMessageSend.mockClear();
    prewarmPersonalSharedAgentTurnCaches.mockClear();
    findActivePersonalDedicatedTarget.mockClear();
    bridge.mockClear();
    ledgerAdmit.mockReset();
    ledgerAdmit.mockResolvedValue({ kind: "claimed", claim: LEDGER_CLAIM });
    ledgerComplete.mockReset();
    ledgerComplete.mockResolvedValue(true);
    ledgerFail.mockReset();
    ledgerFail.mockResolvedValue(true);
    describeInboundImageMedia.mockReset();
    describeInboundImageMedia.mockImplementation(async () => {
      throw new InboundMediaVisionDisabledError(
        "Inbound media vision has no configured provider",
      );
    });
  });

  test("schema accepts allowlisted https media URLs on a Blooio delivery", async () => {
    const response = await request(blooioDelivery());
    expect(response.status).toBe(200);
    expect(ledgerAdmit).toHaveBeenCalledTimes(1);
    expect(describeInboundImageMedia).toHaveBeenCalledTimes(1);
    expect(describeInboundImageMedia.mock.calls[0]?.[1]).toEqual([MEDIA_URL]);
    const env = describeInboundImageMedia.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(env.ELIZA_APP_INBOUND_MEDIA_VISION).toBe("true");
  });

  test("schema rejects mediaUrls on a Twilio delivery", async () => {
    const response = await request(
      blooioDelivery({
        platform: "twilio",
        connectorAccountId: "+15550009999",
      }),
    );
    expect(response.status).toBe(400);
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("schema rejects more media URLs than the image ceiling", async () => {
    const response = await request(
      blooioDelivery({
        mediaUrls: Array.from(
          { length: MAX_INBOUND_MEDIA_IMAGES + 1 },
          (_, index) => `https://media.blooio.com/files/photo-${index}.jpeg`,
        ),
      }),
    );
    expect(response.status).toBe(400);
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
  });

  test("schema rejects media URLs off the Blooio allowlist", async () => {
    for (const url of [
      "https://evil.example/photo.jpeg",
      "https://blooio.com.evil.com/photo.jpeg",
      "http://media.blooio.com/photo.jpeg",
    ]) {
      expect(isAllowedBlooioMediaUrl(url)).toBe(false);
      const response = await request(blooioDelivery({ mediaUrls: [url] }));
      expect(response.status).toBe(400);
    }
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("a Blooio delivery without mediaUrls never consults the vision path", async () => {
    const response = await request(
      blooioDelivery({ mediaUrls: undefined, message: "hey eliza" }),
    );
    expect(response.status).toBe(200);
    expect(ledgerAdmit).not.toHaveBeenCalled();
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
    expect(deliveredMessage()).toBe("hey eliza");
  });

  test("a dark flag keeps the raw media text without touching the ledger", async () => {
    const response = await request(blooioDelivery(), {
      ELIZA_APP_INBOUND_MEDIA_VISION: undefined,
    });
    expect(response.status).toBe(200);
    expect(deliveredMessage()).toBe(RAW_MEDIA_MESSAGE);
    expect(ledgerAdmit).not.toHaveBeenCalled();
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
  });

  test("an enabled flag without a provider keeps the turn byte-identical and records the claim", async () => {
    const response = await request(blooioDelivery());
    expect(response.status).toBe(200);
    expect(deliveredMessage()).toBe(RAW_MEDIA_MESSAGE);
    expect(ledgerFail).toHaveBeenCalledWith(LEDGER_CLAIM, "vision_disabled");
  });

  test("an enabled description enriches the turn as an attached-image block and settles the claim", async () => {
    describeInboundImageMedia.mockResolvedValue(
      "A tabby cat sitting on a mechanical keyboard.",
    );
    const response = await request(blooioDelivery());
    expect(response.status).toBe(200);
    expect(deliveredMessage()).toBe(
      `${RAW_MEDIA_MESSAGE}\n\n[Attached image description]\n` +
        "A tabby cat sitting on a mechanical keyboard.",
    );
    expect(deliveredCapabilityText()).toBeUndefined();
    expect(ledgerAdmit).toHaveBeenCalledTimes(1);
    expect(ledgerAdmit.mock.calls[0]?.[0]).toMatchObject({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "+15550001111",
      sourceMessageId: "blooio:eliza-app:message-42",
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      imageCount: 1,
    });
    expect(ledgerComplete).toHaveBeenCalledWith(
      LEDGER_CLAIM,
      "A tabby cat sitting on a mechanical keyboard.",
    );
  });

  test("a redelivery whose description is already stored is enriched without a provider call", async () => {
    ledgerAdmit.mockResolvedValue({
      kind: "reused",
      description: "A tabby cat sitting on a mechanical keyboard.",
    });
    const response = await request(blooioDelivery());
    expect(response.status).toBe(200);
    expect(deliveredMessage()).toBe(
      `${RAW_MEDIA_MESSAGE}\n\n[Attached image description]\n` +
        "A tabby cat sitting on a mechanical keyboard.",
    );
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
    expect(ledgerComplete).not.toHaveBeenCalled();
  });

  test("every denied admission keeps the raw turn and never calls the provider", async () => {
    describeInboundImageMedia.mockResolvedValue("must not be used");
    const denials: LedgerAdmission[] = [
      { kind: "in_flight" },
      { kind: "previously_failed", reason: "media_fetch_failed" },
      { kind: "identity_mismatch" },
      { kind: "media_mismatch" },
      { kind: "exhausted", scope: "sender", limit: 20, used: 20, requested: 1 },
      {
        kind: "exhausted",
        scope: "connector",
        limit: 1000,
        used: 1000,
        requested: 1,
      },
    ];
    for (const denial of denials) {
      sharedRestMessageSend.mockClear();
      ledgerAdmit.mockResolvedValue(denial);
      const response = await request(blooioDelivery());
      expect(response.status).toBe(200);
      expect(deliveredMessage()).toBe(RAW_MEDIA_MESSAGE);
    }
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
    expect(ledgerComplete).not.toHaveBeenCalled();
    expect(ledgerFail).not.toHaveBeenCalled();
  });

  test("a lost settlement keeps the raw turn instead of using uncommitted OCR text", async () => {
    describeInboundImageMedia.mockResolvedValue("must not enter the turn");
    ledgerComplete.mockResolvedValue(false);
    const response = await request(blooioDelivery());
    expect(response.status).toBe(200);
    expect(deliveredMessage()).toBe(RAW_MEDIA_MESSAGE);
    expect(ledgerComplete).toHaveBeenCalledWith(
      LEDGER_CLAIM,
      "must not enter the turn",
    );
  });

  test("a missing admission decision fails closed: raw turn, no spend, no 500", async () => {
    describeInboundImageMedia.mockResolvedValue("must not be used");
    ledgerAdmit.mockRejectedValue(
      new ElizaError("primary database unreachable", {
        code: "INBOUND_MEDIA_ADMISSION_STORAGE_FAILURE",
      }),
    );
    const response = await request(blooioDelivery());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Eliza-Failure-Stage")).toBeNull();
    expect(deliveredMessage()).toBe(RAW_MEDIA_MESSAGE);
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
  });

  test("a malformed ceiling binding fails closed before the ledger is consulted", async () => {
    describeInboundImageMedia.mockResolvedValue("must not be used");
    const response = await request(blooioDelivery(), {
      ELIZA_APP_INBOUND_MEDIA_VISION_CONNECTOR_DAILY_IMAGES: "unlimited",
    });
    expect(response.status).toBe(200);
    expect(deliveredMessage()).toBe(RAW_MEDIA_MESSAGE);
    expect(ledgerAdmit).not.toHaveBeenCalled();
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
  });

  test("ceiling bindings reach the ledger as the admission policy", async () => {
    describeInboundImageMedia.mockResolvedValue("described");
    await request(blooioDelivery(), {
      ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES: "3",
      ELIZA_APP_INBOUND_MEDIA_VISION_CONNECTOR_DAILY_IMAGES: "40",
    });
    expect(ledgerAdmit.mock.calls[0]?.[0]).toMatchObject({
      ceilings: { senderDailyImages: 3, connectorDailyImages: 40 },
    });
  });

  test("a dedicated-runtime turn skips pooled-key vision and bridges the raw media text", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
    };
    describeInboundImageMedia.mockResolvedValue(
      "A tabby cat sitting on a mechanical keyboard.",
    );
    const response = await request(blooioDelivery());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        identity: { runtime: "dedicated", activeAgentId: activeTarget.id },
        reply: "hello from Dedicated",
      },
    });
    expect(describeInboundImageMedia).not.toHaveBeenCalled();
    expect(ledgerAdmit).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge.mock.calls[0]?.[2].params.text).toBe(RAW_MEDIA_MESSAGE);
  });

  test("a typed enrichment failure degrades to the raw text and records the claim failure", async () => {
    const errorSpy = spyOn(logger, "error");
    describeInboundImageMedia.mockRejectedValue(
      new InboundMediaDescriptionError(
        "Inbound media body read failed",
        "media_read_failed",
      ),
    );
    const response = await request(blooioDelivery());
    expect(response.status).toBe(200);
    expect(deliveredMessage()).toBe(RAW_MEDIA_MESSAGE);
    expect(ledgerFail).toHaveBeenCalledWith(LEDGER_CLAIM, "media_read_failed");
    expect(ledgerComplete).not.toHaveBeenCalled();
    const degradeLog = errorSpy.mock.calls.find(
      ([message]) =>
        message ===
        "[inbound-media-enrichment] inbound media description failed",
    );
    expect(degradeLog?.[1]).toMatchObject({ reason: "media_read_failed" });
    errorSpy.mockRestore();
  });

  test("an unexpected enrichment failure fails the delivery at the media stage", async () => {
    describeInboundImageMedia.mockRejectedValue(new Error("bug"));
    const response = await request(blooioDelivery());
    expect(response.status).toBe(500);
    expect(response.headers.get("X-Eliza-Failure-Stage")).toBe(
      "media_description",
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    // The claim is left to its lease rather than recorded as a terminal
    // outcome the bug did not actually produce.
    expect(ledgerComplete).not.toHaveBeenCalled();
    expect(ledgerFail).not.toHaveBeenCalled();
  });
});
