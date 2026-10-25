import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";

function clientReturning(body: unknown, status = 200): ElizaCloudClient {
  return new ElizaCloudClient({
    baseUrl: "http://cloud.test",
    apiKey: "api-key",
    fetchImpl: (async () =>
      Response.json(body, { status })) as unknown as typeof fetch,
  });
}

/** Exact body of `POST /api/v1/eliza/agents/:agentId/suspend`. */
const suspendBody = {
  success: true,
  created: true,
  alreadyInProgress: false,
  message: "Suspend job created. Poll the job endpoint for status.",
  data: {
    agentId: "agent-1",
    action: "suspend",
    jobId: "job-1",
    status: "pending",
    previousStatus: "running",
  },
};

/** Exact body of `POST /api/v1/eliza/agents` when the organization already had the agent. */
const reusedAgentBody = {
  success: true,
  created: false,
  data: {
    id: "agent-1",
    agentId: "agent-1",
    agentName: "Ops",
    status: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    executionTier: "shared",
  },
};

test("a lifecycle response carries the job id under data, as the routes send it", async () => {
  const response = await clientReturning(suspendBody, 202).suspendAgent(
    "agent-1",
  );

  const jobId: string | undefined = response.data.jobId;
  expect(jobId).toBe("job-1");
  expect(response.data.action).toBe("suspend");
  expect(response.created).toBe(true);
  expect(response.alreadyInProgress).toBe(false);
});

test("createAgent reports whether the agent was created or reused", async () => {
  const response = await clientReturning(reusedAgentBody).createAgent({
    agentName: "Ops",
  });

  const created: boolean | undefined = response.created;
  expect(created).toBe(false);
  expect(response.data?.id).toBe("agent-1");
  expect(response.data?.executionTier).toBe("shared");
});

/** Exact 201 body of `POST /api/v1/eliza/agents` when a warm-pool agent was claimed: no `created`. */
const warmPoolCreateBody = {
  success: true,
  source: "warm_pool",
  data: {
    id: "agent-2",
    agentName: "Ops",
    status: "running",
    webUiUrl: "http://cloud.test/api/v1/eliza/agents/agent-2",
    createdAt: "2026-10-01T00:00:00.000Z",
    executionTier: "dedicated",
  },
};

/** Exact 202 body of `POST /api/v1/eliza/agents` when a provisioning job was enqueued. */
const asyncCreateBody = {
  success: true,
  created: true,
  data: {
    id: "agent-3",
    agentId: "agent-3",
    agentName: "Ops",
    status: "pending",
    jobId: "job-3",
    estimatedCompletionAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    executionTier: "dedicated",
  },
  polling: {
    endpoint: "/api/v1/jobs/job-3",
    intervalMs: 5000,
    expectedDurationMs: 90000,
  },
};

test("createAgent served from the warm pool names its source and has no created flag", async () => {
  const response = await clientReturning(warmPoolCreateBody, 201).createAgent({
    agentName: "Ops",
  });

  const source:
    | "shared_runtime"
    | "warm_pool"
    | "warm_pool_recovery"
    | undefined = response.source;
  expect(source).toBe("warm_pool");
  expect(response.created).toBeUndefined();
  expect(response.data?.webUiUrl).toBe(
    "http://cloud.test/api/v1/eliza/agents/agent-2",
  );
});

test("createAgent names the job to poll when provisioning was enqueued", async () => {
  const response = await clientReturning(asyncCreateBody, 202).createAgent({
    agentName: "Ops",
  });

  expect(response.data?.jobId).toBe("job-3");
  const status: string | undefined = response.data?.status;
  expect(status).toBe("pending");
  expect(response.polling?.endpoint).toBe("/api/v1/jobs/job-3");
  expect(response.polling?.expectedDurationMs).toBe(90000);
});

/** Exact 200 body of `POST /api/v1/eliza/agents/:agentId/provision` for an agent already on the shared runtime. */
const provisionSharedBody = {
  success: true,
  source: "shared_runtime",
  data: {
    id: "agent-1",
    agentName: "Ops",
    status: "running",
    executionTier: "shared",
    message: "Agent is already available on the shared runtime",
    webUiUrl: "http://cloud.test/api/v1/eliza/agents/agent-1",
  },
};

/** Exact 202 body of the same route when a provisioning job was enqueued. */
const provisionJobBody = {
  success: true,
  created: true,
  alreadyInProgress: false,
  message: "Provisioning job created. Poll the job endpoint for status.",
  data: {
    jobId: "job-2",
    agentId: "agent-1",
    status: "pending",
    estimatedCompletionAt: null,
  },
  polling: {
    endpoint: "/api/v1/jobs/job-2",
    intervalMs: 5000,
    expectedDurationMs: 90000,
  },
};

test("provision describes an already available agent without a job", async () => {
  const response =
    await clientReturning(provisionSharedBody).provisionAgent("agent-1");

  expect(response.source).toBe("shared_runtime");
  expect(response.data.jobId).toBeUndefined();
  const id: string | undefined = response.data.id;
  expect(id).toBe("agent-1");
  expect(response.data.webUiUrl).toBe(
    "http://cloud.test/api/v1/eliza/agents/agent-1",
  );
  expect(response.data.agentId).toBeUndefined();
});

test("provision names the job to poll when one was enqueued", async () => {
  const response = await clientReturning(provisionJobBody, 202).provisionAgent(
    "agent-1",
  );

  expect(response.data.jobId).toBe("job-2");
  expect(response.polling?.endpoint).toBe("/api/v1/jobs/job-2");
  expect(response.polling?.expectedDurationMs).toBe(90000);
});

/** Exact 200 body of `DELETE /api/v1/eliza/agents/:agentId` for a shared-runtime agent (route.ts, shared-runtime branch). */
const deleteSharedBody = {
  success: true,
  deleted: true,
  source: "shared_runtime",
  data: { agentId: "agent-1", status: "deleted", executionTier: "shared" },
};

/** Exact 202 body of the same route when a delete job was enqueued. */
const deleteJobBody = {
  success: true,
  created: true,
  alreadyInProgress: false,
  message: "Delete job created. Poll the job endpoint for status.",
  data: { jobId: "job-4", agentId: "agent-1", status: "pending" },
};

/** Exact 200 body of `POST /api/v1/eliza/agents/:agentId/resume` for a running agent (resume/route.ts). */
const resumeRunningBody = {
  success: true,
  data: {
    agentId: "agent-1",
    action: "resume",
    message: "Agent is already running",
    status: "running",
    webUiUrl: null,
  },
};

test("delete and resume bodies carry data on every success path", async () => {
  const shared = await clientReturning(deleteSharedBody).deleteAgent("agent-1");
  expect(shared.deleted).toBe(true);
  expect(shared.source).toBe("shared_runtime");
  expect(shared.data.status).toBe("deleted");

  const queued = await clientReturning(deleteJobBody, 202).deleteAgent(
    "agent-1",
  );
  expect(queued.data.jobId).toBe("job-4");

  const resumed =
    await clientReturning(resumeRunningBody).resumeAgent("agent-1");
  expect(resumed.data.action).toBe("resume");
  expect(resumed.data.webUiUrl).toBeNull();
});
