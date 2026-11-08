import { beforeEach, expect, mock, test } from "bun:test";

const ROUTER_ORG = "00000000-0000-4000-8000-0000000000a1";
const TENANT_ORG = "00000000-0000-4000-8000-0000000000b2";
const AGENT_X_ID = "900";

let callerOrg = ROUTER_ORG;
const accountLookups: unknown[] = [];
const deliveries: unknown[] = [];

mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: callerOrg,
  }),
}));
const identity = await import(
  "@elizaos/cloud-shared/lib/services/eliza-app/x-personal-identity"
);
mock.module(
  "@elizaos/cloud-shared/lib/services/eliza-app/x-personal-identity",
  () => ({
    ...identity,
    findOrCreateXPersonalAccount: async (params: unknown) => {
      accountLookups.push(params);
      return {
        user: { id: "sender-user" },
        organization: { id: "sender-org" },
        isNew: false,
      };
    },
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/twitter-automation", () => ({
  twitterAutomationService: {
    getStoredConnectionIdentity: async () => ({ twitterUserId: AGENT_X_ID }),
  },
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/shared-runtime/resolve-shared-agent",
  () => ({
    resolveSharedRuntimeWorkerRequestContext: () => ({
      executionCtx: {},
      namespace: {},
    }),
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/personal-message-delivery",
  () => ({
    deliverPersonalTextMessage: async (params: unknown) => {
      deliveries.push(params);
      return { success: true, reply: "Your calendar is clear." };
    },
  }),
);

const { _resetRedisUnavailableFallbackBuckets } = await import(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare"
);
const { default: app } = await import("./route");

const delivery = {
  recipientTwitterUserId: AGENT_X_ID,
  senderTwitterUserId: "12345",
  senderUsername: "alice",
  dmEventId: "dm-1",
  message: "list my calendar",
};

function post(env: Record<string, unknown>) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delivery),
    },
    env,
  );
}

beforeEach(() => {
  callerOrg = ROUTER_ORG;
  accountLookups.length = 0;
  deliveries.length = 0;
  _resetRedisUnavailableFallbackBuckets();
});

test("an organization outside the router allowlist gets 403 and no account lookup", async () => {
  callerOrg = TENANT_ORG;
  const response = await post({ X_PERSONAL_DM_ROUTER_ORG_IDS: ROUTER_ORG });
  expect(response.status).toBe(403);
  expect(accountLookups).toHaveLength(0);
  expect(deliveries).toHaveLength(0);
});

test("an unset or empty allowlist refuses every caller", async () => {
  for (const env of [{}, { X_PERSONAL_DM_ROUTER_ORG_IDS: " , " }]) {
    const response = await post(env);
    expect(response.status).toBe(403);
  }
  expect(accountLookups).toHaveLength(0);
});

test("the allowlisted router gets the reply to send as the DM", async () => {
  const response = await post({
    X_PERSONAL_DM_ROUTER_ORG_IDS: `${TENANT_ORG.toUpperCase()}, ${ROUTER_ORG}`,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { reply: string } };
  expect(body.data.reply).toBe("Your calendar is clear.");
  expect(accountLookups).toEqual([
    { twitterUserId: "12345", username: "alice", displayName: undefined },
  ]);
});

test("the router organization is rate limited past its bucket", async () => {
  const env = { X_PERSONAL_DM_ROUTER_ORG_IDS: ROUTER_ORG };
  for (let i = 0; i < 300; i++) {
    expect((await post(env)).status).toBe(200);
  }
  const limited = await post(env);
  expect(limited.status).toBe(429);
  expect(accountLookups).toHaveLength(300);
});
