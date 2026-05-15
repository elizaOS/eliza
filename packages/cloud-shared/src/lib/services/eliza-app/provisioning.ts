import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import type { AgentSandbox } from "../../../db/schemas/agent-sandboxes";
import { elizaSandboxService } from "../eliza-sandbox";
import { provisioningJobService } from "../provisioning-jobs";
import { logger } from "../../utils/logger";

const DEFAULT_AGENT_NAME = "Eliza";
const DEFAULT_DOCKER_IMAGE = "elizaos/eliza:latest";

export interface ElizaAppProvisioningStatus {
  status: string;
  agentId: string | null;
  bridgeUrl: string | null;
  sandbox: AgentSandbox | null;
}

export function toElizaAppProvisioningStatus(
  sandbox: Pick<AgentSandbox, "id" | "status" | "bridge_url"> | null | undefined,
): ElizaAppProvisioningStatus {
  if (!sandbox) {
    return {
      status: "none",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    };
  }

  return {
    status: sandbox.status,
    agentId: sandbox.id,
    bridgeUrl: sandbox.status === "running" ? (sandbox.bridge_url ?? null) : null,
    sandbox: sandbox as AgentSandbox,
  };
}

export function publicElizaAppProvisioningPayload(status: ElizaAppProvisioningStatus) {
  return {
    status: status.status,
    ...(status.agentId ? { agentId: status.agentId } : {}),
    ...(status.bridgeUrl ? { bridgeUrl: status.bridgeUrl } : {}),
  };
}

export async function getElizaAppProvisioningStatus(
  organizationId: string,
): Promise<ElizaAppProvisioningStatus> {
  const sandboxes = await agentSandboxesRepository.listByOrganization(organizationId);
  return toElizaAppProvisioningStatus(sandboxes[0]);
}

export async function ensureElizaAppProvisioning(params: {
  organizationId: string;
  userId: string;
}): Promise<ElizaAppProvisioningStatus> {
  const existing = await getElizaAppProvisioningStatus(params.organizationId);
  if (existing.sandbox) {
    return existing;
  }

  const sandbox = await elizaSandboxService.createAgent({
    organizationId: params.organizationId,
    userId: params.userId,
    agentName: DEFAULT_AGENT_NAME,
    dockerImage: DEFAULT_DOCKER_IMAGE,
  });

  await provisioningJobService.enqueueAgentProvision({
    agentId: sandbox.id,
    organizationId: params.organizationId,
    userId: params.userId,
    agentName: DEFAULT_AGENT_NAME,
  });

  logger.info("[eliza-app provisioning] Provisioning kicked off", {
    agentId: sandbox.id,
    orgId: params.organizationId,
  });

  return toElizaAppProvisioningStatus(sandbox);
}
