/**
 * Classifies a loaded runtime action into an automation-node `class` from its
 * declared tags: actions carrying the agent-orchestration + delegate capability
 * tags surface as `"agent"` nodes, everything else as plain `"action"` nodes.
 */
import { type Action, hasActionTags } from "@elizaos/core";
import type { AutomationNodeDescriptor } from "@elizaos/shared";

const AGENT_AUTOMATION_ACTION_TAGS = [
  "domain:agent-orchestration",
  "capability:delegate",
] as const;

export function classifyRuntimeActionNode(
  action: Pick<Action, "tags">,
): AutomationNodeDescriptor["class"] {
  return hasActionTags(action, AGENT_AUTOMATION_ACTION_TAGS)
    ? "agent"
    : "action";
}
