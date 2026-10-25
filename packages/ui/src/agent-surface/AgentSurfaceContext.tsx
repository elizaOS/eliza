/**
 * AgentSurfaceProvider — supplies the per-view ViewAgentRegistry to descendant
 * elements via React context. Mounted by DynamicViewLoader around every view so
 * any view that calls `useAgentElement` is automatically agent-controllable.
 *
 * The context object and useAgentSurface hook live in
 * ./AgentSurfaceContext.hooks so this file can export only the provider
 * component (React Fast Refresh-compatible).
 */

import { type ReactNode, useContext, useEffect, useRef } from "react";
import {
  AgentSurfaceContext,
  type AgentSurfaceContextValue,
} from "./AgentSurfaceContext.hooks";
import { getOrCreateViewRegistry, retainViewRegistry } from "./registry";
import type { AgentViewType } from "./types";

export interface AgentSurfaceProviderProps {
  viewId: string;
  viewType?: AgentViewType;
  installationId?: string;
  children: ReactNode;
}

export function AgentSurfaceProvider({
  viewId,
  viewType = "gui",
  installationId: explicitInstallationId,
  children,
}: AgentSurfaceProviderProps) {
  const parent = useContext(AgentSurfaceContext);
  const installationId =
    explicitInstallationId ??
    (parent?.viewId === viewId && parent.viewType === viewType
      ? parent.registry.installationId
      : undefined);
  // The registry instance is owned for the lifetime of this provider.
  const valueRef = useRef<AgentSurfaceContextValue | null>(null);
  if (
    !valueRef.current ||
    valueRef.current.viewId !== viewId ||
    valueRef.current.viewType !== viewType ||
    valueRef.current.registry.installationId !== installationId
  ) {
    valueRef.current = {
      registry: getOrCreateViewRegistry(viewId, viewType, installationId),
      viewId,
      viewType,
    };
  }

  const value = valueRef.current;

  useEffect(() => retainViewRegistry(value.registry), [value.registry]);

  return (
    <AgentSurfaceContext.Provider value={value}>
      {children}
    </AgentSurfaceContext.Provider>
  );
}
