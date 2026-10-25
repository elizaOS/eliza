import { setTimeout as wait } from "node:timers/promises";
import { type IAgentRuntime, Service } from "@elizaos/core";
import { DeviceActionError, object } from "./contract.ts";
import { DeviceActionService } from "./service.ts";
import type { WorkflowDeviceDispatch } from "./workflow-contract.ts";

/** Fixed workflow executor bridge, with the ordinary phone approval queue as sole effect authority. */
export class WorkflowDeviceBridgeService extends Service {
  static serviceType = "workflow_device_bridge";
  capabilityDescription =
    "Explicitly reviewed workflow reads and Notes writes on an enrolled phone";
  static async start(runtime: IAgentRuntime) {
    return new WorkflowDeviceBridgeService(runtime);
  }
  async stop(): Promise<void> {}
  async validateTarget(
    owner: string,
    target: { installationId: string; enrollmentId: string },
    minimumProtocol = 1,
  ): Promise<void> {
    await new DeviceActionService(this.runtime).validateWorkflowTarget(
      owner,
      target,
      minimumProtocol,
    );
  }
  async dispatch(
    subjectUserId: string,
    request: WorkflowDeviceDispatch,
    signal: AbortSignal,
  ): Promise<unknown> {
    const service = new DeviceActionService(this.runtime);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const proposal = await service.proposeForWorkflow(subjectUserId, request);
      if (proposal.state === "done") {
        const receipt = object(proposal.execution?.providerReceipt);
        if (receipt.outcome !== "applied")
          throw new DeviceActionError(
            "Workflow device effect has no applied receipt",
          );
        return {
          proposalId: proposal.id,
          operationId: receipt.operationId,
          ...(receipt.result === undefined ? {} : { result: receipt.result }),
        };
      }
      if (
        ["rejected", "expired", "cancelled"].includes(proposal.state) ||
        proposal.expiresAt.getTime() <= Date.now()
      )
        throw new DeviceActionError(
          "Workflow device review rejected or expired",
        );
      if (proposal.state === "reconciliation_required")
        throw new DeviceActionError(
          "Workflow device outcome requires explicit reconciliation",
        );
      await wait(500, undefined, { signal });
    }
    throw new DeviceActionError("Workflow device review deadline expired");
  }
}
