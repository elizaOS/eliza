/**
 * Proves the inbound-media admission ledger at the real boundary: the trusted
 * messaging route, the real enrichment orchestrator and describe helper, and
 * the production repository against isolated PGlite with the real 0310
 * migration. Only the network edges are faked (the SSRF-guarded fetch, the
 * vision provider factory, and the AI SDK call) plus the unrelated turn
 * collaborators. Pinned here: a redelivery reuses the stored description
 * without a second provider call, a body-stream failure degrades to the raw
 * media text with a 200 and a recorded terminal failure, the per-sender and
 * per-connector daily ceilings deny at the route, and a ledger outage fails
 * closed without spending or failing the delivery.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);

const ORG_A = "73000000-0000-4000-8000-000000000001";
const ORG_B = "73000000-0000-4000-8000-000000000002";
const USER_A = "73000000-0000-4000-8000-000000000011";
const USER_B = "73000000-0000-4000-8000-000000000012";
const PHONE_A = "+15551234567";
const PHONE_B = "+15557654321";
const CONNECTOR_ID = "+15550001111";
const MEDIA_URL = "https://media.blooio.com/files/photo-1.jpeg";
const RAW_MEDIA_MESSAGE = `[media: ${MEDIA_URL}]`;
const DESCRIPTION = "A tabby cat sitting on a mechanical keyboard.";

const resolvePersonalDelivery = mock(
  async (params: { phoneNumber?: string }) =>
    params.phoneNumber === PHONE_B
      ? {
          userId: USER_B,
          organizationId: ORG_B,
          dedicatedTarget: null,
          isNew: false,
          resolution: "single-query-repeat" as const,
        }
      : {
          userId: USER_A,
          organizationId: ORG_A,
          dedicatedTarget: null,
          isNew: false,
          resolution: "single-query-repeat" as const,
        },
);
const sharedRestMessageSend = mock(async (..._args: unknown[]) => ({
  text: "hello from Eliza",
}));
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeExecutionCtx = {
  waitUntil: mock((_promise: Promise<unknown>) => undefined),
};

// Network edges of the describe helper: the SSRF-guarded fetch and the
// vision provider. Everything between the route and these edges is real.
const safeFetch = mock(
  async (_url: string, _init?: RequestInit): Promise<Response> =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    }),
);
const getLanguageModel = mock((_model: string): unknown => "vision-model");
const generateText = mock(
  async (
    _options: unknown,
  ): Promise<{ text: string; finishReason: string }> => ({
    text: DESCRIPTION,
    finishReason: "stop",
  }),
);
const actualSafeFetch = await import("@/lib/security/safe-fetch");
mock.module("@/lib/security/safe-fetch", () => ({
  ...actualSafeFetch,
  safeFetch,
}));
const actualLanguageModel = await import("@/lib/providers/language-model");
mock.module("@/lib/providers/language-model", () => ({
  ...actualLanguageModel,
  getLanguageModel,
}));
const actualAi = await import("ai");
mock.module("ai", () => ({ ...actualAi, generateText }));

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
  prewarmPersonalSharedAgentTurnCaches: mock(async () => undefined),
}));
mock.module("@/lib/services/eliza-app/onboarding-chat", () => ({
  runOnboardingChat: mock(async () => ({
    loginUrl: "https://cloud-staging.eliza.app/get-started",
  })),
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget: mock(async () => null),
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
    bridge: mock(async () => ({
      jsonrpc: "2.0",
      id: "x",
      result: { text: "" },
    })),
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

const { closeDatabaseConnectionsForTests, getPgliteClientForTests } =
  await import("@/db/client");
const { default: app } = await import("./route");
const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };

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

function blooioDelivery(
  messageId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: CONNECTOR_ID,
    phoneNumber: PHONE_A,
    messageId: `blooio:eliza-app:${messageId}`,
    message: RAW_MEDIA_MESSAGE,
    mediaUrls: [MEDIA_URL],
    ...overrides,
  };
}

async function deliver(
  messageId: string,
  overrides: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
): Promise<string> {
  sharedRestMessageSend.mockClear();
  const response = await request(blooioDelivery(messageId, overrides), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Eliza-Failure-Stage")).toBeNull();
  expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
  return sharedRestMessageSend.mock.calls[0]?.[2] as string;
}

async function ledgerRow(messageId: string) {
  const { rows } = await getPgliteClientForTests().query<{
    state: string;
    description: string | null;
    failure_reason: string | null;
    attempt_count: number;
    organization_id: string;
  }>(
    `SELECT state, description, failure_reason, attempt_count, organization_id
     FROM personal_shared_inbound_media_descriptions WHERE source_message_id = $1`,
    [`blooio:eliza-app:${messageId}`],
  );
  return rows[0];
}

async function quotaRows() {
  const { rows } = await getPgliteClientForTests().query<{
    scope: string;
    scope_key: string;
    image_count: number;
  }>(
    `SELECT scope, scope_key, image_count FROM personal_shared_inbound_media_quotas
     ORDER BY scope, scope_key`,
  );
  return rows;
}

const ENRICHED = `${RAW_MEDIA_MESSAGE}\n\n[Attached image description]\n${DESCRIPTION}`;

beforeAll(async () => {
  const database = getPgliteClientForTests();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
  `);
  const migration = await Bun.file(
    new URL(
      "../../../../../shared/src/db/migrations/0310_personal_shared_inbound_media_admission.sql",
      import.meta.url,
    ),
  ).text();
  await database.exec(migration);
});

beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    TRUNCATE personal_shared_inbound_media_descriptions,
      personal_shared_inbound_media_quotas,
      users,
      organizations CASCADE;
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO users (id) VALUES ('${USER_A}'), ('${USER_B}');
  `);
  safeFetch.mockClear();
  safeFetch.mockImplementation(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
  );
  generateText.mockClear();
  generateText.mockResolvedValue({ text: DESCRIPTION, finishReason: "stop" });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("inbound media admission ledger through the messaging route", () => {
  test("a redelivery of the same connector message id reuses the stored description without re-spending", async () => {
    expect(await deliver("message-1")).toBe(ENRICHED);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(await ledgerRow("message-1")).toMatchObject({
      state: "described",
      description: DESCRIPTION,
      organization_id: ORG_A,
    });

    // The provider redelivers (or the gateway reopens) the same message.
    expect(await deliver("message-1")).toBe(ENRICHED);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(await quotaRows()).toEqual([
      {
        scope: "connector",
        scope_key: `blooio:eliza-app:${CONNECTOR_ID}`,
        image_count: 1,
      },
      { scope: "sender", scope_key: ORG_A, image_count: 1 },
    ]);

    // A redelivery carrying different media under the same id is not reused
    // and, being the same message, is not a second claim either.
    expect(
      await deliver("message-1", {
        mediaUrls: ["https://media.blooio.com/files/photo-2.jpeg"],
        message: "[media: https://media.blooio.com/files/photo-2.jpeg]",
      }),
    ).toBe("[media: https://media.blooio.com/files/photo-2.jpeg]");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("a body stream that fails mid-read keeps the raw media message with a 200 and records the failure", async () => {
    let pulls = 0;
    safeFetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulls++ === 0) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
              } else {
                controller.error(
                  new DOMException(
                    "The operation was aborted due to timeout",
                    "TimeoutError",
                  ),
                );
              }
            },
          }),
          { status: 200, headers: { "content-type": "image/jpeg" } },
        ),
    );
    expect(await deliver("message-2")).toBe(RAW_MEDIA_MESSAGE);
    expect(generateText).not.toHaveBeenCalled();
    expect(await ledgerRow("message-2")).toMatchObject({
      state: "failed",
      failure_reason: "media_read_failed",
      description: null,
    });

    // The redelivery neither refetches nor retries the terminal attempt.
    safeFetch.mockClear();
    expect(await deliver("message-2")).toBe(RAW_MEDIA_MESSAGE);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test("the sender ceiling is enforced at the route with no provider call past it", async () => {
    const env = { ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES: "2" };
    expect(await deliver("message-3a", {}, env)).toBe(ENRICHED);
    expect(await deliver("message-3b", {}, env)).toBe(ENRICHED);
    expect(await deliver("message-3c", {}, env)).toBe(RAW_MEDIA_MESSAGE);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(await ledgerRow("message-3c")).toBeUndefined();
    expect(await quotaRows()).toEqual([
      {
        scope: "connector",
        scope_key: `blooio:eliza-app:${CONNECTOR_ID}`,
        image_count: 2,
      },
      { scope: "sender", scope_key: ORG_A, image_count: 2 },
    ]);
    // Another sender of the same connector still has its own budget.
    expect(await deliver("message-3d", { phoneNumber: PHONE_B }, env)).toBe(
      ENRICHED,
    );
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  test("the connector ceiling bounds pooled spend across every sender", async () => {
    const env = { ELIZA_APP_INBOUND_MEDIA_VISION_CONNECTOR_DAILY_IMAGES: "2" };
    expect(await deliver("message-4a", {}, env)).toBe(ENRICHED);
    expect(await deliver("message-4b", { phoneNumber: PHONE_B }, env)).toBe(
      ENRICHED,
    );
    expect(await deliver("message-4c", { phoneNumber: PHONE_B }, env)).toBe(
      RAW_MEDIA_MESSAGE,
    );
    expect(await deliver("message-4d", {}, env)).toBe(RAW_MEDIA_MESSAGE);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(await quotaRows()).toEqual([
      {
        scope: "connector",
        scope_key: `blooio:eliza-app:${CONNECTOR_ID}`,
        image_count: 2,
      },
      { scope: "sender", scope_key: ORG_A, image_count: 1 },
      { scope: "sender", scope_key: ORG_B, image_count: 1 },
    ]);
  });

  test("a zero ceiling denies every description while the flag stays on", async () => {
    expect(
      await deliver(
        "message-5",
        {},
        { ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES: "0" },
      ),
    ).toBe(RAW_MEDIA_MESSAGE);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(await ledgerRow("message-5")).toBeUndefined();
  });

  test("a ledger outage fails closed: raw turn, 200, no spend", async () => {
    const database = getPgliteClientForTests();
    await database.exec(
      "ALTER TABLE personal_shared_inbound_media_quotas RENAME TO quotas_offline",
    );
    try {
      expect(await deliver("message-6")).toBe(RAW_MEDIA_MESSAGE);
    } finally {
      await database.exec(
        "ALTER TABLE quotas_offline RENAME TO personal_shared_inbound_media_quotas",
      );
    }
    expect(safeFetch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    // The claim transaction rolled back with the outage.
    expect(await ledgerRow("message-6")).toBeUndefined();
    // Once the ledger is back the same message is admitted normally.
    expect(await deliver("message-6")).toBe(ENRICHED);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("a dark flag never touches the ledger", async () => {
    expect(
      await deliver(
        "message-7",
        {},
        { ELIZA_APP_INBOUND_MEDIA_VISION: undefined },
      ),
    ).toBe(RAW_MEDIA_MESSAGE);
    expect(await ledgerRow("message-7")).toBeUndefined();
    expect(await quotaRows()).toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
