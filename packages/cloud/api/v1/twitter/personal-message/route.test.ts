/** X personal DM delivery accepts sender ids only from the allowlisted platform DM router. */
import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ROUTER_ORG = "00000000-0000-4000-8000-0000000000aa";
const TENANT_ORG = "00000000-0000-4000-8000-0000000000bb";
const AGENT_X_ID = "900";

let callerOrg = ROUTER_ORG;
const accountLookups: unknown[] = [];

mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "router-user",
    organization_id: callerOrg,
  }),
}));
const identityActual = await import(
  "@elizaos/cloud-shared/lib/services/eliza-app/x-personal-identity"
);
mock.module(
  "@elizaos/cloud-shared/lib/services/eliza-app/x-personal-identity",
  () => ({
    ...identityActual,
    findOrCreateXPersonalAccount: async (params: unknown) => {
      accountLookups.push(params);
      return { user: { id: "personal-user" }, organization: {}, isNew: false };
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/personal-message-delivery",
  () => ({
    deliverPersonalTextMessage: async () => ({
      success: true,
      reply: "hello back",
    }),
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/shared-runtime/resolve-shared-agent",
  () => ({
    resolveSharedRuntimeWorkerRequestContext: () => ({
      executionCtx: undefined,
      namespace: undefined,
    }),
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/twitter-automation", () => ({
  twitterAutomationService: {
    getStoredConnectionIdentity: async () => ({ twitterUserId: AGENT_X_ID }),
  },
}));

const { default: route } = await import("./route");
const path = "/api/v1/twitter/personal-message";
const app = new Hono().route(path, route);

beforeEach(() => {
  callerOrg = ROUTER_ORG;
  accountLookups.length = 0;
});

let dmEvent = 0;
async function deliver(env: Record<string, string>) {
  dmEvent += 1;
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipientTwitterUserId: AGENT_X_ID,
        senderTwitterUserId: "123",
        senderUsername: "alice",
        dmEventId: `dm-${dmEvent}`,
        message: "hi",
      }),
    },
    { REDIS_RATE_LIMITING: "false", ...env },
  );
}

test("refuses an organization outside the router allowlist", async () => {
  callerOrg = TENANT_ORG;
  const response = await deliver({ X_PERSONAL_DM_ROUTER_ORG_IDS: ROUTER_ORG });
  expect(response.status).toBe(403);
  expect(accountLookups).toHaveLength(0);
});

test("refuses everyone when the allowlist is unset", async () => {
  const response = await deliver({});
  expect(response.status).toBe(403);
  expect(accountLookups).toHaveLength(0);
});

test("delivers for the allowlisted router and returns the reply", async () => {
  const response = await deliver({
    X_PERSONAL_DM_ROUTER_ORG_IDS: ` ${TENANT_ORG.toUpperCase()}, ${ROUTER_ORG} `,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    success: boolean;
    data: { reply: string };
  };
  expect(body.success).toBe(true);
  expect(body.data.reply).toBe("hello back");
  expect(accountLookups).toEqual([
    {
      twitterUserId: "123",
      username: "alice",
      displayName: undefined,
    },
  ]);
});

test("rate limits the router organization", async () => {
  callerOrg = TENANT_ORG;
  const env = { X_PERSONAL_DM_ROUTER_ORG_IDS: TENANT_ORG };
  for (let i = 0; i < 600; i += 1) {
    const response = await deliver(env);
    expect(response.status).toBe(200);
  }
  const limited = await deliver(env);
  expect(limited.status).toBe(429);
  expect(accountLookups).toHaveLength(600);
});
