/** Reports the current Dedicated provisioning state to Eliza App onboarding. */
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import {
  type ElizaAppProvisioningStatus,
  selectElizaAppProvisioningTarget,
  toElizaAppProvisioningStatus,
} from "./provisioning-observation";

export * from "./provisioning-observation";

export async function getElizaAppProvisioningStatus(
  organizationId: string,
  userId: string,
): Promise<ElizaAppProvisioningStatus> {
  const sandboxes = await agentSandboxesRepository.listByOrganization(organizationId);
  return toElizaAppProvisioningStatus(selectElizaAppProvisioningTarget(sandboxes, userId));
}
