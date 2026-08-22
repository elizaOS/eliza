/**
 * Exercises the Dedicated cutover relay with the REAL Shared reminder
 * dispatcher for group destinations: after cutover the deliver route still
 * re-verifies the group binding and prefixes the group send, and an inactive
 * binding fails the relay closed. Mocked auth, source row, and repository;
 * intercepted gateway fetch.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { organization_id: "org-owner" },
}));
const getAgent = mock(async () => ({ id: "dedicated-agent" }));
const BINDING_ID = "8b8f2c69-6a3e-4a0f-9be1-1f8f6a3e4a0f";
const committedGroupTask = {
  taskId: "shared-reminder-1",
  kind: "reminder" as const,
  promptInstructions: "pay the rent",
  ownerVisible: true,
  contextRequest: undefined,
  output: { fallback: { body: "pay the rent" } },
  metadata: {
    dispatchIdempotencyKey: "shared-reminder-1:2026-08-15T17:00:00.000Z",
    delivery: {
      platform: "telegram",
      kind: "group",
      project: "eliza-app",
      chatId: "-100123456789",
      groupBindingId: BINDING_ID,
      ownerLabel: "Nubs",
    },
  },
};
const readCommittedSharedReminderForTarget = mock(
  async () => committedGroupTask,
);
const activeBinding = {
  id: BINDING_ID,
  organization_id: "00000000-0000-4000-8000-000000000001",
  owner_user_id: "00000000-0000-4000-8000-000000000002",
  personal_agent_id: "personal:00000000-0000-5000-8000-000000000000",
  platform: "telegram",
  project: "eliza-app",
  connector_account_id: "telegram:test-bot",
  provider_chat_id: "-100123456789",
  conversation_id: "group:00000000-0000-5000-8000-000000000030",
  state: "active",
  response_policy: "mention_only",
  created_by_platform_user_id: "123456789",
};
const findBindingById = mock(
  async (): Promise<Record<string, unknown> | null> => activeBinding,
);
const recordDeliveryReceipts = mock(async () => 1);

mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent },
}));
mock.module("@/lib/services/shared-runtime/shared-scheduling", () => ({
  readCommittedSharedReminderForTarget,
  createSharedScheduledTaskRunner: mock(() => {
    throw new Error("the relay must not open a Shared runner");
  }),
  executeSharedSchedulingSql: mock(async () => []),
}));
mock.module("@/db/repositories/personal-shared-groups", () => ({
  personalSharedGroupsRepository: {
    findBindingById,
    recordDeliveryReceipts,
  },
}));

const route = (
  await import(
    "../v1/eliza/agents/[agentId]/shared-reminders/[taskId]/deliver/route"
  )
).default;
const app = new Hono<AppEnv>();
app.route(
  "/api/v1/eliza/agents/:agentId/shared-reminders/:taskId/deliver",
  route,
);
const originalFetch = globalThis.fetch;

function request() {
  return app.request(
    "/api/v1/eliza/agents/dedicated-agent/shared-reminders/shared-reminder-1/deliver",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "agent-key" },
      body: JSON.stringify({ firedAtIso: "2026-08-15T17:00:00.000Z" }),
    },
    {
      ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.example/",
      GATEWAY_INTERNAL_SECRET: "internal-secret",
    } as AppEnv["Bindings"],
  );
}

beforeEach(() => {
  findBindingById.mockClear();
  findBindingById.mockImplementation(async () => activeBinding);
  recordDeliveryReceipts.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Dedicated cutover group reminder relay", () => {
  test("re-verifies the binding and delivers the prefixed group send", async () => {
    const requests: Request[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const outgoing = new Request(input, init);
        requests.push(outgoing);
        const body = (await outgoing.clone().json()) as Record<string, unknown>;
        return Response.json({
          success: true,
          idempotencyKey: body.idempotencyKey,
          acceptedAt: "2026-08-15T17:00:00.100Z",
          providerMessageIds: ["provider-group-1"],
        });
      },
    ) as unknown as typeof fetch;

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      metadata: { providerMessageIds: ["provider-group-1"] },
    });
    expect(findBindingById).toHaveBeenCalledWith(BINDING_ID);
    expect(requests[0]?.url).toBe("https://gateway.example/internal/deliver");
    await expect(requests[0]?.json()).resolves.toEqual({
      platform: "telegram",
      project: "eliza-app",
      chatId: "-100123456789",
      text: "Reminder for this group from Nubs: pay the rent",
      idempotencyKey: "shared-reminder-1:2026-08-15T17:00:00.000Z",
    });
    expect(recordDeliveryReceipts).toHaveBeenCalledTimes(1);
  });

  test("fails the relay closed when the binding was revoked after cutover", async () => {
    findBindingById.mockImplementationOnce(async () => ({
      ...activeBinding,
      state: "revoked",
    }));
    globalThis.fetch = mock(async () => {
      throw new Error("connector egress must not run");
    }) as unknown as typeof fetch;

    const response = await request();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      reason: "unknown_recipient",
      acceptance: "not_accepted",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(recordDeliveryReceipts).not.toHaveBeenCalled();
  });
});
