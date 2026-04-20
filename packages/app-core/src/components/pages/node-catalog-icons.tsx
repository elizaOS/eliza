/**
 * Shared node-icon helpers used by both AutomationsView and NodeCatalogView.
 */

import {
  Clock3,
  GitBranch,
  Mail,
  Settings,
  Signal,
  SquareTerminal,
  Workflow,
  Zap,
} from "lucide-react";
import type { JSX } from "react";
import type { AutomationNodeDescriptor } from "../../api/client";

export const NODE_CLASS_ORDER = [
  "agent",
  "action",
  "context",
  "integration",
  "trigger",
  "flow-control",
] as const satisfies ReadonlyArray<AutomationNodeDescriptor["class"]>;

export function getNodeClassLabel(
  className: AutomationNodeDescriptor["class"],
): string {
  switch (className) {
    case "agent":
      return "Agent";
    case "action":
      return "Actions";
    case "context":
      return "Context";
    case "integration":
      return "Integrations";
    case "trigger":
      return "Triggers";
    case "flow-control":
      return "Flow Control";
    default:
      return className;
  }
}

export function getNodeIcon(node: AutomationNodeDescriptor): JSX.Element {
  if (node.source === "lifeops_event") {
    return <Zap className="h-3.5 w-3.5" />;
  }
  if (node.source === "lifeops") {
    if (node.id === "lifeops:gmail") return <Mail className="h-3.5 w-3.5" />;
    if (node.id === "lifeops:signal") return <Signal className="h-3.5 w-3.5" />;
    if (node.id === "lifeops:github") {
      return <GitBranch className="h-3.5 w-3.5" />;
    }
  }
  if (node.class === "agent") {
    return <SquareTerminal className="h-3.5 w-3.5" />;
  }
  if (node.class === "integration") {
    return <Workflow className="h-3.5 w-3.5" />;
  }
  if (node.class === "context") {
    return <Settings className="h-3.5 w-3.5" />;
  }
  if (node.class === "trigger") {
    return <Clock3 className="h-3.5 w-3.5" />;
  }
  return <Zap className="h-3.5 w-3.5" />;
}
