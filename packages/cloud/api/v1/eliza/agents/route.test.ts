import { beforeEach, expect, mock, test } from "bun:test"

const enqueueAgentProvisionOnce = mock(async () => ({
  job: { id: "job-1" },
  created: true,
}))
const triggerImmediate = mock(async () => undefined)
const createAgent = mock(async () => ({
  agent: {
    id: "agent-1",
    agent_name: "existing",
    status: "pending",
    created_at: new Date("2026-10-15T00:00:00.000Z"),
    execution_tier: "dedicated-always",
  },
  idempotent: true,
}))

mock.module("@elizaos/cloud-shared/agents", () => ({
  provisioningJobService: {
    enqueueAgentProvisionOnce,
    triggerImmediate,
  },
}))
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
    steward_id: undefined,
  }),
}))
mock.module("@elizaos/cloud-shared/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {},
}))
mock.module("@elizaos/cloud-shared/db/repositories/characters", () => ({
  userCharactersRepository: {},
}))
mock.module("@elizaos/cloud-shared/lib/api/cloud-worker-errors", () => ({
  ApiError: class extends Error {},
  NotFoundError: (message: string) => new Error(message),
  ValidationError: (message: string) => new Error(message),
}))
mock.module("@elizaos/cloud-shared/lib/config/containers-env", () => ({
  containersEnv: {
    warmPoolEnabled: () => false,
    defaultAgentImage: () => "eliza:test",
  },
}))
mock.module("@elizaos/cloud-shared/lib/constants/agent-sandbox-quota", () => ({
  getMaxNonTerminalAgentsForOrg: () => 10,
}))
mock.module("@elizaos/cloud-shared/lib/eliza-agent-web-ui", () => ({
  getConfiguredElizaAgentPublicWebUiUrl: () => "https://agent.test",
}))
mock.module("@elizaos/cloud-shared/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate: async () => ({ allowed: true, balance: 10 }),
}))
mock.module("@elizaos/cloud-shared/lib/services/agent-billing-gate-402", () => ({
  insufficientCredits402: () => ({ success: false }),
}))
mock.module(
  "@elizaos/cloud-shared/lib/services/dedicated-compute-price-acceptance",
  () => ({ requireDedicatedComputePriceAcceptance: () => null }),
)
mock.module("@elizaos/cloud-shared/lib/services/eliza-agent-config", () => ({
  AGENT_PROVISIONING_DEFERRED_KEY: "__agentProvisioningDeferred",
  stripReservedElizaConfigKeys: (value: Record<string, unknown> | undefined) => value ?? {},
  withReusedElizaCharacterOwnership: (value: Record<string, unknown>) => value,
}))
mock.module("@elizaos/cloud-shared/lib/services/eliza-managed-launch", () => ({
  prepareManagedElizaEnvironment: async () => ({
    changed: false,
    environmentVars: {},
  }),
}))
mock.module("@elizaos/cloud-shared/lib/services/eliza-sandbox", () => ({
  AgentImageNotAllowedError: class extends Error {},
  AgentQuotaExceededError: class extends Error {},
  elizaSandboxService: {
    createAgent,
    listAgents: async () => [],
  },
}))
mock.module("@elizaos/cloud-shared/lib/services/job-error-text", () => ({
  publicJobErrorSummary: () => "job failed",
}))
mock.module("@elizaos/cloud-shared/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: async () => ({ ok: true, required: false }),
  provisioningWorkerFailureBody: () => ({ success: false }),
}))
mock.module("@elizaos/cloud-shared/lib/services/shared-runtime/agent-tier", () => ({
  getAgentTier: () => "dedicated-always",
  tierProvisionsEagerly: (tier: string) => tier !== "shared",
}))
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}))

const { default: app } = await import("./route")

beforeEach(() => {
  enqueueAgentProvisionOnce.mockClear()
  triggerImmediate.mockClear()
  createAgent.mockClear()
})

async function post(path: string): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentName: "retry", alwaysOn: true }),
  })
}

test("normal retry repairs a reused pending eager agent without duplicating its job", async () => {
  const response = await post("/")

  expect(response.status).toBe(200)
  expect(enqueueAgentProvisionOnce).toHaveBeenCalledTimes(1)
  expect(triggerImmediate).toHaveBeenCalledTimes(1)
  expect(enqueueAgentProvisionOnce).toHaveBeenCalledWith({
    agentId: "agent-1",
    organizationId: "org-1",
    userId: "user-1",
    agentName: "existing",
  })
})

test("explicit deferred retry leaves a reused pending eager agent unqueued", async () => {
  const response = await post("/?autoProvision=false")

  expect(response.status).toBe(200)
  expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled()
  expect(triggerImmediate).not.toHaveBeenCalled()
})
