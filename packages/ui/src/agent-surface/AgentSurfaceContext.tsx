/**
 * AgentSurfaceProvider — supplies the per-view ViewAgentRegistry to descendant
 * elements via React context. Mounted by DynamicViewLoader around every view so
 * any view that calls `useAgentElement` is automatically agent-controllable.
 *
 * The context object and useAgentSurface hook live in
 * ./AgentSurfaceContext.hooks so this file can export only the provider
 * component (React Fast Refresh-compatible).
 */

import { type ReactNode, useEffect, useRef } from "react";
import {
  AgentSurfaceContext,
  type AgentSurfaceContextValue,
} from "./AgentSurfaceContext.hooks";
import {
  attachViewRegistry,
  getOrCreateViewRegistry,
  removeViewRegistry,
} from "./registry";
import type { AgentViewType } from "./types";

export interface AgentSurfaceProviderProps {
  viewId: string;
  viewType?: AgentViewType;
  children: ReactNode;
}

export function AgentSurfaceProvider({
  viewId,
  viewType = "gui",
  children,
}: AgentSurfaceProviderProps) {
  // The registry instance is owned for the lifetime of this provider.
  const valueRef = useRef<AgentSurfaceContextValue | null>(null);
  if (
    !valueRef.current ||
    valueRef.current.viewId !== viewId ||
    valueRef.current.viewType !== viewType
  ) {
    valueRef.current = {
      registry: getOrCreateViewRegistry(viewId, viewType),
      viewId,
      viewType,
    };
  }

  useEffect(() => {
    const registry = valueRef.current?.registry;
    if (!registry) return;

    // React StrictMode replays effects without replaying provider state. Keep
    // the globally discoverable entry tied to the registry children received.
    attachViewRegistry(viewId, viewType, registry);
    return () => removeViewRegistry(viewId, viewType, registry);
  }, [viewId, viewType]);

  return (
    <AgentSurfaceContext.Provider value={valueRef.current}>
      {children}
    </AgentSurfaceContext.Provider>
  );
}
