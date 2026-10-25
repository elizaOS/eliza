/**
 * AgentSurface context object + useAgentSurface hook. Kept out of
 * AgentSurfaceContext.tsx so that file exports only the AgentSurfaceProvider
 * component (React Fast Refresh-compatible).
 */

import { createContext, useContext } from "react";
import type { ViewAgentRegistry } from "./registry";
import type { AgentViewType } from "./types";

export interface AgentSurfaceContextValue {
  registry: ViewAgentRegistry;
  viewId: string;
  viewType: AgentViewType;
}

export const AgentSurfaceContext =
  createContext<AgentSurfaceContextValue | null>(null);

/** Returns the active view's registry, or null when rendered outside a view. */
export function useAgentSurface(): AgentSurfaceContextValue | null {
  return useContext(AgentSurfaceContext);
}
