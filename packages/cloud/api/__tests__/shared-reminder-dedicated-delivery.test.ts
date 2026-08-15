/** Exercises the authenticated Cloud relay for reminders migrated into Dedicated runtimes. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { organization_id: "org-owner" },
}));
const getAgent = mock(async () => ({ id: "dedicated-agent" }));
const committedTask = {
  taskId: "shared-reminder-1",
  kind: "reminder" as const,
  promptInstructions: "trusted stored reminder",
  ownerVisible: true,
  contextRequest: undefined,
  metadata: {
    delivery: { platform: "telegram", project: "main", chatId: "42" },
  },
};
const readCommittedSharedReminderForTarget = mock(
  async (_input: { targetAgentId: string; taskId: string }) =>
    committedTask as typeof committedTask | undefined,
);
const dispatch = mock(
  async (_record: unknown): Promise<Record<string, unknown>> => ({
    ok: true,
    metadata: { providerMessageIds: ["91"] },
  }),
);

mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent },
}));
mock.module("@/lib/services/shared-runtime/shared-scheduling", () => ({
  readCommittedSharedReminderForTarget,
}));
mock.module("@/lib/services/shared-runtime/shared-reminder-cron", () => ({
  sharedReminderDispatcher: () => ({ dispatch }),
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

function request(body: unknown = { firedAtIso: "2026-08-15T17:00:00.000Z" }) {
  return app.request(
    "/api/v1/eliza/agents/dedicated-agent/shared-reminders/shared-reminder-1/deliver",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "agent-key" },
      body: JSON.stringify(body),
    },
    {} as AppEnv["Bindings"],
  );
}

beforeEach(() => {
  requireAuthOrApiKeyWithOrg.mockClear();
  getAgent.mockClear();
  readCommittedSharedReminderForTarget.mockClear();
  dispatch.mockClear();
});

describe("Dedicated Shared-reminder delivery", () => {
  test("re-authorizes the target and dispatches only the committed source row", async () => {
    const response = await request({
      firedAtIso: "2026-08-15T17:00:00.000Z",
      text: "caller-controlled text",
      chatId: "999",
    });

    expect(response.status).toBe(200);
    expect(getAgent).toHaveBeenCalledWith("dedicated-agent", "org-owner");
    expect(readCommittedSharedReminderForTarget).toHaveBeenCalledWith({
      targetAgentId: "dedicated-agent",
      taskId: "shared-reminder-1",
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "shared-reminder-1",
        promptInstructions: "trusted stored reminder",
        metadata: {
          delivery: { platform: "telegram", project: "main", chatId: "42" },
        },
      }),
    );
    expect(JSON.stringify(dispatch.mock.calls[0]?.[0])).not.toContain("999");
    expect(await response.json()).toMatchObject({
      success: true,
      metadata: { providerMessageIds: ["91"] },
    });
  });

  test("fails closed when no committed source row belongs to the target", async () => {
    readCommittedSharedReminderForTarget.mockResolvedValueOnce(undefined);
    const response = await request();
    expect(response.status).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("keeps unknown provider acceptance unsuccessful", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      reason: "transport_error",
      acceptance: "unknown",
      userActionable: true,
    });
    const response = await request();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      success: false,
      acceptance: "unknown",
    });
  });
});
