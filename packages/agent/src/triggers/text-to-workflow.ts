/**
 * Phase 2E: workflow unification.
 *
 * Every trigger persisted to disk is `kind: "workflow"`. Callers may still
 * submit `kind: "text"` (or omit `kind`) for back-compat; this helper
 * transparently materializes a single-node `respondToEvent` workflow that
 * carries the original instructions, then returns the deployed workflow id
 * + name so the caller can store the trigger as `kind: "workflow"`.
 *
 * The agent package cannot import from `@elizaos/plugin-workflow` (that
 * would create a startup cycle), so we look the service up by string id
 * and constrain it via {@link WorkflowServiceLike}.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { TriggerWakeMode } from "./types.js";

const WORKFLOW_SERVICE_TYPE = "workflow";
const RESPOND_TO_EVENT_NODE_TYPE = "workflows-nodes-base.respondToEvent";

export interface TextTriggerWorkflowDraft {
  displayName: string;
  instructions: string;
  wakeMode: TriggerWakeMode;
}

export interface DeployedTriggerWorkflow {
  id: string;
  name: string;
}

/**
 * Minimal shape of the workflow plugin's deploy entry point that we depend
 * on. Defined locally so the agent package never imports the workflow
 * plugin directly.
 */
export interface WorkflowServiceLike {
  deployWorkflow(
    workflow: {
      name: string;
      nodes: Array<{
        id?: string;
        name: string;
        type: string;
        typeVersion?: number;
        position: [number, number];
        parameters: Record<string, unknown>;
      }>;
      connections: Record<string, unknown>;
      active?: boolean;
    },
    userId: string,
  ): Promise<{ id?: string; name?: string }>;
}

function isWorkflowServiceLike(value: unknown): value is WorkflowServiceLike {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { deployWorkflow?: unknown }).deployWorkflow === "function"
  );
}

export function getWorkflowService(
  runtime: IAgentRuntime,
): WorkflowServiceLike | null {
  const svc = runtime.getService(WORKFLOW_SERVICE_TYPE);
  return isWorkflowServiceLike(svc) ? svc : null;
}

/**
 * Deploy a single-node `respondToEvent` workflow that wraps a text-style
 * trigger's instructions. Returns the deployed workflow id + name on
 * success, or `null` if deploy failed (e.g. the workflow service did not
 * return an id, which happens for missing-credentials short-circuits).
 */
export async function deployTextTriggerWorkflow(
  runtime: IAgentRuntime,
  draft: TextTriggerWorkflowDraft,
  ownerId: string,
): Promise<DeployedTriggerWorkflow | null> {
  const service = getWorkflowService(runtime);
  if (!service) return null;

  const workflowName = `${draft.displayName} (auto)`;
  const deployed = await service.deployWorkflow(
    {
      name: workflowName,
      nodes: [
        {
          name: "respondToEvent",
          type: RESPOND_TO_EVENT_NODE_TYPE,
          typeVersion: 1,
          position: [0, 0],
          parameters: {
            instructions: draft.instructions,
            displayName: draft.displayName,
            wakeMode: draft.wakeMode,
          },
        },
      ],
      connections: {},
      active: true,
    },
    ownerId,
  );

  if (!deployed.id) return null;
  return { id: deployed.id, name: deployed.name ?? workflowName };
}
