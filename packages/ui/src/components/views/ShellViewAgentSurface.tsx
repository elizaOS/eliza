/**
 * Connects shell-rendered pages to the agent interaction registry.
 * Native plugin pages carry the same semantic handlers and authority catalog
 * as their remote bundles. The broker denies human-only operations before
 * dispatch; builtin pages retain their existing opt-in element controls.
 */

import {
  resolveSurfaceManifest,
  type SurfaceManifest,
  type ViewCapability,
} from "@elizaos/core";
import { type ReactNode, useEffect, useRef } from "react";
import {
  AgentElementOverlay,
  AgentSurfaceElementReporter,
  AgentSurfaceProvider,
  type AgentViewType,
  getViewRegistry,
  handleAgentSurfaceCapability,
  isAgentSurfaceCapability,
} from "../../agent-surface";
import type { RegisteredAgentSurfaceKind } from "../../app-shell-registry";
import { brokerViewInteract } from "./view-capability-broker";
import { registerViewInteractHandler } from "./view-interact-registry";

function idParam(params: Record<string, unknown> | undefined): string | null {
  const id = params?.agentId ?? params?.id;
  return typeof id === "string" ? id : null;
}

export interface ShellViewAgentSurfaceProps {
  /** Stable builtin view id (matches the entry in builtin-views.ts). */
  viewId: string;
  viewType?: AgentViewType;
  /** Registry family that generated this bridge owner, when applicable. */
  surfaceKind?: RegisteredAgentSurfaceKind | "builtin";
  /** Semantic authority shared with the owning plugin's remote view. */
  capabilities?: readonly ViewCapability[];
  surface?: SurfaceManifest;
  interact?: (
    capability: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  children: ReactNode;
}

export function ShellViewAgentSurface({
  viewId,
  viewType = "gui",
  surfaceKind = "builtin",
  capabilities,
  surface,
  interact,
  children,
}: ShellViewAgentSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = async (
      capability: string,
      params?: Record<string, unknown>,
    ) => {
      if (interact && capabilities?.some((entry) => entry.id === capability)) {
        return interact(capability, params);
      }
      const registry = getViewRegistry(viewId, viewType);
      if (isAgentSurfaceCapability(capability)) {
        if (!registry) {
          throw new Error(
            `Shell view "${viewId}" has no agent surface registered yet`,
          );
        }
        return handleAgentSurfaceCapability(registry, capability, params);
      }
      switch (capability) {
        case "get-text":
          return containerRef.current?.innerText ?? "";
        case "get-state":
          return registry && registry.size() > 0 ? registry.snapshot() : {};
        case "focus-element": {
          const id = idParam(params);
          if (id && registry) {
            const r = registry.focus(id);
            return { focused: r.ok, id, reason: r.reason };
          }
          return { focused: false, reason: "agentId required" };
        }
        case "click-element": {
          const id = idParam(params);
          if (id && registry) {
            const r = registry.click(id);
            return { clicked: r.ok, id, reason: r.reason };
          }
          return { clicked: false, reason: "agentId required" };
        }
        case "fill-input": {
          const id = idParam(params);
          const value = typeof params?.value === "string" ? params.value : null;
          if (value === null) {
            return { filled: false, reason: "value must be a string" };
          }
          if (id && registry) {
            const r = registry.fill(id, value);
            return { filled: r.ok, id, reason: r.reason, value };
          }
          return { filled: false, reason: "agentId required" };
        }
        default:
          throw new Error(
            `Shell view "${viewId}" does not support capability "${capability}"`,
          );
      }
    };
    return registerViewInteractHandler(
      viewId,
      viewType,
      capabilities
        ? brokerViewInteract(
            viewId,
            resolveSurfaceManifest({ surface }),
            handler,
            capabilities,
          )
        : handler,
    );
  }, [viewId, viewType, capabilities, surface, interact]);

  return (
    <AgentSurfaceProvider viewId={viewId} viewType={viewType}>
      <div
        ref={containerRef}
        className="contents"
        data-agent-surface-kind={surfaceKind}
        data-agent-surface-view-id={viewId}
      >
        {children}
      </div>
      <AgentElementOverlay />
      <AgentSurfaceElementReporter />
    </AgentSurfaceProvider>
  );
}
