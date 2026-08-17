/**
 * GET /api/compat/agents/:id/logs tail contract at the HTTP boundary.
 *
 * Auth, sandbox lookup, and the logs enqueue are stubbed so a 400 can be
 * proven write-free. Prefix-coercible garbage must not become docker
 * `logs --tail N`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireCompatAuth = mock(async () => ({
  user: {
    id: "compat-user-1",
    organization_id: "compat-org-1",
  },
  authMethod: "standard" as const,
}));

const getAgent = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    status: string;
  } | null> => ({
    id: "compat-agent-1",
    organization_id: "compat-org-1",
    status: "running",
  }),
);

const enqueueAgentLogsOnce = mock(async () => ({
  created: true,
  job: {
    id: "compat-logs-job-1",
    status: "pending",
  },
}));
const triggerImmediate = mock(async () => undefined);

mock.module("../../../_lib/auth", () => ({
  requireCompatAuth,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    getAgent,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentLogsOnce,
    triggerImmediate,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const { default: logsRoute, parseCompatLogsTail } = await import("./route");

describe("parseCompatLogsTail", () => {
  test.each([
    [null, 100],
    ["1", 1],
    ["100", 100],
    ["5000", 5000],
  ] as const)("accepts %s", (raw, expected) => {
    expect(parseCompatLogsTail(raw)).toEqual({ ok: true, tail: expected });
  });

  test.each([
    ["", "empty"],
    ["1e4", "scientific notation that parseInt truncates to 1"],
    ["12px", "trailing junk"],
    ["007", "leading zeros"],
    ["0", "zero"],
    ["-1", "signed"],
    ["0x10", "hex"],
    ["5001", "above max"],
    ["9007199254740992", "unsafe integer"],
    ["Infinity", "Infinity"],
  ] as const)("rejects %s (%s)", (raw) => {
    expect(parseCompatLogsTail(raw)).toEqual({ ok: false });
  });
});

describe("compat agent logs tail contract", () => {
  const app = new Hono();
  app.route("/api/compat/agents/:id/logs", logsRoute);

  beforeEach(() => {
    requireCompatAuth.mockClear();
    getAgent.mockClear();
    getAgent.mockResolvedValue({
      id: "compat-agent-1",
      organization_id: "compat-org-1",
      status: "running",
    });
    enqueueAgentLogsOnce.mockClear();
    enqueueAgentLogsOnce.mockResolvedValue({
      created: true,
      job: {
        id: "compat-logs-job-1",
        status: "pending",
      },
    });
    triggerImmediate.mockClear();
  });

  async function requestLogs(query = "") {
    return app.fetch(
      new Request(
        `https://api.example.test/api/compat/agents/compat-agent-1/logs${query}`,
        { method: "GET" },
      ),
    );
  }

  test("omitted tail defaults to 100 and enqueues", async () => {
    const response = await requestLogs();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        jobId: "compat-logs-job-1",
        tail: 100,
        agentStatus: "running",
      },
    });
    expect(enqueueAgentLogsOnce).toHaveBeenCalledWith({
      agentId: "compat-agent-1",
      organizationId: "compat-org-1",
      userId: "compat-user-1",
      tail: 100,
    });
  });

  test("canonical tail=10 is forwarded unchanged", async () => {
    const response = await requestLogs("?tail=10");
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { tail: 10 },
    });
    expect(enqueueAgentLogsOnce).toHaveBeenCalledWith(
      expect.objectContaining({ tail: 10 }),
    );
  });

  test("unknown agent 404s after a canonical tail and does not enqueue", async () => {
    getAgent.mockResolvedValueOnce(null);
    const response = await requestLogs("?tail=10");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Agent not found",
    });
    expect(enqueueAgentLogsOnce).not.toHaveBeenCalled();
  });

  test.each([
    ["1e4", "scientific notation"],
    ["12px", "trailing junk"],
    ["007", "leading zeros"],
    ["0", "zero"],
    ["5001", "above max"],
  ] as const)(
    "returns 400 and does not look up or enqueue for tail=%s (%s)",
    async (raw) => {
      const response = await requestLogs(`?tail=${encodeURIComponent(raw)}`);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: "tail must be a whole number between 1 and 5000",
      });
      expect(getAgent).not.toHaveBeenCalled();
      expect(enqueueAgentLogsOnce).not.toHaveBeenCalled();
    },
  );
});
