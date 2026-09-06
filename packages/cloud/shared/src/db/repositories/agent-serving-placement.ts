/** Validates persisted serving placement before deletion can use its immutable provider authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { AgentServingPlacement } from "../schemas/agent-sandboxes";

const placement = z.object({
  version: z.literal(1),
  locator: z.object({
    sandboxId: z.string().min(1),
    nodeId: z.string().min(1),
    containerName: z.string().min(1),
    containerId: z.string().regex(/^[0-9a-f]{64}$/),
    nodeRecordId: z.string().uuid(),
    nodeHostname: z.string().min(1),
    nodeSshPort: z.number().int().min(1).max(65535),
    nodeSshUser: z.string().min(1),
    nodeHostKeyFingerprint: z.string().min(1),
  }),
});

/** Missing published authority must never fall back to a reusable node or container name. */
export function servingDeletionAuthority(
  receipt: AgentServingPlacement,
  expected: {
    agentId: string;
    nodeId: string | null;
    sandboxId: string | null;
    containerName: string | null;
  },
) {
  const parsed = placement.safeParse(receipt);
  if (
    !parsed.success ||
    parsed.data.locator.nodeId !== expected.nodeId ||
    parsed.data.locator.sandboxId !== expected.sandboxId ||
    parsed.data.locator.containerName !== expected.containerName
  ) {
    throw new ElizaError("Serving deletion placement differs from its captured authority", {
      code: "AGENT_SERVING_DELETE_AUTHORITY_MISMATCH",
      context: { agentId: expected.agentId },
    });
  }
  const locator = parsed.data.locator;
  return {
    agentId: expected.agentId,
    nodeId: locator.nodeId,
    nodeRecordId: locator.nodeRecordId,
    sandboxId: locator.sandboxId,
    containerId: locator.containerId,
    containerName: locator.containerName,
    hostname: locator.nodeHostname,
    sshPort: locator.nodeSshPort,
    sshUser: locator.nodeSshUser,
    hostKeyFingerprint: locator.nodeHostKeyFingerprint,
  };
}
