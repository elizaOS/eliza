import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";

/** The exact body `GET /api/v1/jobs/:jobId` returns for a finished job. */
const completedJob = {
  success: true,
  data: {
    id: "job-1",
    type: "agent_provision",
    status: "completed",
    result: { agentId: "agent-1" },
    error: null,
    attempts: 1,
    maxAttempts: 3,
    estimatedCompletionAt: null,
    scheduledFor: null,
    startedAt: "2026-10-13T12:00:00.000Z",
    completedAt: "2026-10-13T12:00:05.000Z",
    createdAt: "2026-10-13T11:59:59.000Z",
    updatedAt: "2026-10-13T12:00:05.000Z",
  },
  polling: { shouldContinue: false },
};

function clientReturning(body: unknown, onCall?: () => void): ElizaCloudClient {
  return new ElizaCloudClient({
    baseUrl: "http://cloud.test",
    apiKey: "api-key",
    fetchImpl: (async () => {
      onCall?.();
      return Response.json(body);
    }) as unknown as typeof fetch,
  });
}

test("getJob returns the job envelope the route sends", async () => {
  const response = await clientReturning(completedJob).getJob("job-1");

  expect(response.success).toBe(true);
  expect(response.data.status).toBe("completed");
  expect(response.data.result).toEqual({ agentId: "agent-1" });
  expect(response.data.type).toBe("agent_provision");
});

test("pollJob resolves on the first completed envelope instead of timing out", async () => {
  let calls = 0;
  const client = clientReturning(completedJob, () => {
    calls += 1;
  });

  const job = await client.pollJob("job-1", { timeoutMs: 200, intervalMs: 10 });

  expect(job.status).toBe("completed");
  expect(job.id).toBe("job-1");
  expect(calls).toBe(1);
});
