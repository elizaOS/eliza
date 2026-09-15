/** Defines durable replacement identity and the expected authority for retiring old sandbox resources. */
import { type AgentSandboxStatus } from "../../../../db/repositories/agent-sandboxes";

export type ReplacementCleanupLocator = {
  sandboxId: string;
  nodeId: string;
  containerName: string;
  replacementAttemptId: string | null;
  containerId: string | null;
  vpnNodeId: string | null;
  vpnNodeName: string | null;
  previousVpnNodeId: string | null;
  vpnRegistrationStartedAt: Date | null;
  allocationCounted: boolean;
  createdAt: Date;
};

export type ReplacementCleanupExpectation = {
  status: AgentSandboxStatus;
  environmentRevision: number;
  sandboxId: string | null;
  nodeId: string | null;
  containerName: string | null;
};

export interface AdminCanaryCleanupExpectation {
  targetOwnerUserId: string;
  targetImage: string;
  targetDigest: string;
  newNodeId: string;
  newContainerName: string;
  oldNodeId: string;
  oldContainerName: string;
}

export class AdminCanaryCleanupExpectationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminCanaryCleanupExpectationError";
  }
}
