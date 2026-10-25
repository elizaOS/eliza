/**
 * capabilities — translates agent view-interact capability calls into
 * ViewAgentRegistry operations. DynamicViewLoader routes any capability in
 * AGENT_SURFACE_CAPABILITY_IDS here before falling back to selector handling.
 */

import type { ViewAgentRegistry } from "./registry";
import {
  AGENT_SURFACE_CAPABILITY_IDS,
  type AgentActionResult,
  type AgentElementRole,
  type AgentElementSnapshot,
  type AgentSurfaceSnapshot,
} from "./types";

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function isAgentSurfaceCapability(capability: string): boolean {
  return AGENT_SURFACE_CAPABILITY_IDS.has(capability);
}

/**
 * Handle one agent-surface capability against a view's registry.
 * Throws on a missing required parameter so the failure surfaces to the agent
 * (rather than silently returning a default).
 */
export function handleAgentSurfaceCapability(
  registry: ViewAgentRegistry,
  capability: string,
  params: Record<string, unknown> | undefined,
):
  | AgentSurfaceSnapshot
  | AgentElementSnapshot
  | AgentElementSnapshot[]
  | AgentActionResult
  | { focusedId: string | null; element: AgentElementSnapshot | null }
  | { highlighting: boolean } {
  switch (capability) {
    case "list-elements": {
      const snapshot = registry.snapshot();
      const role = asString(params?.role) as AgentElementRole | null;
      const group = asString(params?.group);
      let elements = snapshot.elements;
      if (role) elements = elements.filter((e) => e.role === role);
      if (group) elements = elements.filter((e) => e.group === group);
      return elements;
    }

    case "get-agent-state":
      return registry.snapshot();

    case "describe-element": {
      const id = asString(params?.id);
      if (!id) throw new Error("describe-element requires an `id` parameter");
      const element = registry.describe(id);
      if (!element) throw new Error(`No element registered with id "${id}"`);
      return element;
    }

    case "get-focus": {
      const focusedId = registry.getFocusedId();
      return {
        focusedId,
        element: focusedId ? registry.describe(focusedId) : null,
      };
    }

    case "agent-click": {
      const id = asString(params?.id);
      if (!id) throw new Error("agent-click requires an `id` parameter");
      return registry.click(id);
    }

    case "agent-fill": {
      const id = asString(params?.id);
      const value = asString(params?.value);
      if (!id) throw new Error("agent-fill requires an `id` parameter");
      if (value === null) {
        throw new Error("agent-fill requires a string `value` parameter");
      }
      return registry.fill(id, value);
    }

    case "agent-focus": {
      const id = asString(params?.id);
      if (!id) throw new Error("agent-focus requires an `id` parameter");
      return registry.focus(id);
    }

    case "agent-scroll-to": {
      const id = asString(params?.id);
      if (!id) throw new Error("agent-scroll-to requires an `id` parameter");
      return registry.scrollTo(id);
    }

    case "set-highlight": {
      const on = params?.on !== false;
      registry.setHighlight(on);
      return { highlighting: registry.isHighlighting() };
    }

    default:
      throw new Error(`Unknown agent-surface capability "${capability}"`);
  }
}
