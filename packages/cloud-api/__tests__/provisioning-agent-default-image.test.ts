import { describe, expect, mock, test } from "bun:test";

// Mock containersEnv BEFORE any import of the route module — DEFAULT_DOCKER_IMAGE
// is evaluated at import time, so the mock must be in place first.
mock.module("@/lib/config/containers-env", () => ({
  containersEnv: {
    defaultAgentImage: () => "ghcr.io/elizaos/eliza:stable",
  },
}));

// Spread real modules so other exports survive for later test files.
import * as agentSandboxesActual from "@/db/repositories/agent-sandboxes";
import * as elizaAppActual from "@/lib/services/eliza-app";
import * as elizaSandboxActual from "@/lib/services/eliza-sandbox";
import * as provisioningJobsActual from "@/lib/services/provisioning-jobs";
import * as loggerActual from "@/lib/utils/logger";

const mockCreateAgent = mock(async () => ({
  id: "agent-test-1",
  status: "pending",
  bridge_url: null,
}));

const mockEnqueueAgentProvision = mock(async () => ({}));
const mockListByOrganization = mock(async () => []);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  ...agentSandboxesActual,
  agentSandboxesRepository: {
    ...agentSandboxesActual.agentSandboxesRepository,
    listByOrganization: mockListByOrganization,
  },
}));

mock.module("@/lib/services/eliza-app", () => ({
  ...elizaAppActual,
  elizaAppSessionService: {
    ...elizaAppActual.elizaAppSessionService,
    validateAuthHeader: mock(async (header: string) =>
      header.startsWith("Bearer ")
        ? { userId: "user-1", organizationId: "org-1" }
        : null,
    ),
  },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  ...elizaSandboxActual,
  elizaSandboxService: {
    ...elizaSandboxActual.elizaSandboxService,
    createAgent: mockCreateAgent,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  ...provisioningJobsActual,
  provisioningJobService: {
    ...provisioningJobsActual.provisioningJobService,
    enqueueAgentProvision: mockEnqueueAgentProvision,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}));

// Import after all mocks are in place.
const { default: app } = await import("../eliza-app/provisioning-agent/route");

interface CreateAgentTestParams {
  organizationId: string;
  userId: string;
  agentName: string;
  dockerImage: string;
}

/** Extract the first argument of the first `createAgent` call, or null. */
function firstCreateAgentCall(): CreateAgentTestParams | null {
  // bun's mock type declares `calls` as `[]` (fixed empty tuple), so we widen
  // through `unknown[]` before indexing.
  const calls = mockCreateAgent.mock.calls as unknown as unknown[][];
  if (calls.length === 0) return null;
  return (calls[0]![0] ?? null) as CreateAgentTestParams | null;
}

describe("provisioning-agent DEFAULT_DOCKER_IMAGE", () => {
  test("POST handler passes the canonical ghcr.io image to createAgent", async () => {
    mockListByOrganization.mockResolvedValue([]);
    mockCreateAgent.mockResolvedValue({
      id: "agent-test-1",
      status: "pending",
      bridge_url: null,
    });

    // The Hono app's route handlers are at "/" — the router mounts the app
    // at "/api/eliza-app/provisioning-agent" in production.
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { Authorization: "Bearer valid-session-token" },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    // Assert createAgent was called with the canonical ghcr.io image
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    const call = firstCreateAgentCall();
    expect(call).toBeDefined();
    expect(call!.dockerImage).toBe("ghcr.io/elizaos/eliza:stable");
  });

  test("rejects the legacy bare image name (no ghcr.io prefix)", async () => {
    mockListByOrganization.mockResolvedValue([]);
    mockCreateAgent.mockResolvedValue({
      id: "agent-test-1",
      status: "pending",
      bridge_url: null,
    });

    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { Authorization: "Bearer valid-session-token" },
    });

    await app.fetch(req);

    const call = firstCreateAgentCall();
    expect(call).toBeDefined();
    // Should NOT be the bare Docker Hub name that caused "unauthorized"
    expect(call!.dockerImage).not.toBe("elizaos/eliza:latest");
  });

  test("image starts with ghcr.io/ (the correct registry)", async () => {
    mockListByOrganization.mockResolvedValue([]);
    mockCreateAgent.mockResolvedValue({
      id: "agent-test-1",
      status: "pending",
      bridge_url: null,
    });

    const req = new Request("http://localhost/", {
      method: "POST",
      headers: { Authorization: "Bearer valid-session-token" },
    });

    await app.fetch(req);

    const call = firstCreateAgentCall();
    expect(call).toBeDefined();
    expect(call!.dockerImage).toMatch(/^ghcr\.io\//);
  });
});
