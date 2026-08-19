/**
 * Route-level contract for warming both rowless Personal Shared identities and
 * sandbox-backed Shared agents without sending namespaced IDs to Postgres UUID lookups.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const listRecentlyActiveAgentIds = mock(async (): Promise<string[]> => []);
const findById = mock(
  async (id: string): Promise<{ id: string } | undefined> => ({ id }),
);
const prewarmSharedAgentTurnCaches = mock(async () => undefined);
const prewarmSharedElizaRuntime = mock(async () => undefined);

mock.module("@/db/repositories/shared-runtime-history", () => ({
  sharedRuntimeHistoryRepository: { listRecentlyActiveAgentIds },
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { findById },
}));

mock.module("@/lib/services/shared-runtime/prewarm-shared-agent", () => ({
  prewarmSharedAgentTurnCaches,
}));

mock.module("@/lib/services/shared-runtime/shared-eliza-runtime", () => ({
  prewarmSharedElizaRuntime,
}));

const { default: app } = await import("./route");

const PERSONAL_AGENT_ID = "personal:9610511b-dff2-5ca3-989a-8e1004ff44b1";
const SANDBOX_AGENT_ID = "9610511b-dff2-4ca3-889a-8e1004ff44b2";

function hitCron() {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: { "x-cron-secret": "cron-secret" },
    }),
    {
      CRON_SECRET: "cron-secret",
      SHARED_RUNTIME_CONVERSATIONS: {},
    },
  );
}

beforeEach(() => {
  listRecentlyActiveAgentIds.mockClear();
  findById.mockClear();
  prewarmSharedAgentTurnCaches.mockClear();
  prewarmSharedElizaRuntime.mockClear();
});

describe("shared-agent keepwarm cron", () => {
  test("warms the runtime without querying rowless Personal Shared IDs as sandbox UUIDs", async () => {
    listRecentlyActiveAgentIds.mockResolvedValueOnce([PERSONAL_AGENT_ID]);

    const response = await hitCron();
    const body = (await response.json()) as {
      success: boolean;
      data: {
        candidates: number;
        warmed: number;
        rowlessPersonal: number;
        missing: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { candidates: 1, warmed: 0, rowlessPersonal: 1, missing: 0 },
    });
    expect(findById).not.toHaveBeenCalled();
    expect(prewarmSharedAgentTurnCaches).not.toHaveBeenCalled();
    expect(prewarmSharedElizaRuntime).toHaveBeenCalledTimes(1);
  });

  test("preserves per-agent cache warming for sandbox-backed Shared agents", async () => {
    listRecentlyActiveAgentIds.mockResolvedValueOnce([
      PERSONAL_AGENT_ID,
      SANDBOX_AGENT_ID,
    ]);

    const response = await hitCron();
    const body = (await response.json()) as {
      success: boolean;
      data: {
        candidates: number;
        warmed: number;
        rowlessPersonal: number;
        missing: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { candidates: 2, warmed: 1, rowlessPersonal: 1, missing: 0 },
    });
    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith(SANDBOX_AGENT_ID);
    expect(prewarmSharedAgentTurnCaches).toHaveBeenCalledTimes(1);
    expect(prewarmSharedElizaRuntime).toHaveBeenCalledTimes(1);
  });

  test("counts missing sandbox rows without attempting to warm them", async () => {
    listRecentlyActiveAgentIds.mockResolvedValueOnce([SANDBOX_AGENT_ID]);
    findById.mockResolvedValueOnce(undefined);

    const response = await hitCron();
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { candidates: 1, warmed: 0, rowlessPersonal: 0, missing: 1 },
    });
    expect(prewarmSharedAgentTurnCaches).not.toHaveBeenCalled();
    expect(prewarmSharedElizaRuntime).toHaveBeenCalledTimes(1);
  });

  test("rejects an invalid cron secret before querying history", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "wrong-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: "Invalid cron secret",
      code: "authentication_required",
    });
    expect(listRecentlyActiveAgentIds).not.toHaveBeenCalled();
  });
});
