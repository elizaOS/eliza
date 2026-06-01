/**
 * AgentSurfaceProvider — supplies the per-view ViewAgentRegistry to descendant
 * elements via React context. Mounted by DynamicViewLoader around every view so
 * any view that calls `useAgentElement` is automatically agent-controllable.
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";
import {
  getOrCreateViewRegistry,
  removeViewRegistry,
  type ViewAgentRegistry,
} from "./registry";
import type { AgentViewType } from "./types";

interface AgentSurfaceContextValue {
  registry: ViewAgentRegistry;
  viewId: string;
  viewType: AgentViewType;
}

const AgentSurfaceContext = createContext<AgentSurfaceContextValue | null>(
  null,
);

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
    // Re-assert the module-map entry on mount (it may have been created above
    // during render) and tear it down on unmount.
    getOrCreateViewRegistry(viewId, viewType);
    return () => removeViewRegistry(viewId, viewType);
  }, [viewId, viewType]);

  return (
    <AgentSurfaceContext.Provider value={valueRef.current}>
      {children}
    </AgentSurfaceContext.Provider>
  );
}

/** Returns the active view's registry, or null when rendered outside a view. */
export function useAgentSurface(): AgentSurfaceContextValue | null {
  return useContext(AgentSurfaceContext);
}

export { AgentSurfaceContext };
