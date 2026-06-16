import { PageHeaderProvider, TooltipProvider } from "@elizaos/ui";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useCanvasStore } from "@/lib/stores/canvas-store";
import { CloudAssistantPill } from "./cloud-assistant-pill";
import { CloudCanvas } from "./cloud-canvas";

function pathToNodeType(
  pathname: string,
): { targetType: string; nodeName: string } | null {
  if (!pathname.startsWith("/dashboard")) return null;
  const subPath = pathname.slice("/dashboard".length).replace(/^\/|\/$/g, "");
  if (!subPath) return null;

  // Exact mappings for specific dashboard sub-paths
  const exactMappings: Record<
    string,
    { targetType: string; nodeName: string }
  > = {
    "api-keys": { targetType: "apikeys", nodeName: "api keys" },
    mcps: { targetType: "mcps", nodeName: "mcp servers" },
    "security/permissions": {
      targetType: "securityPermissions",
      nodeName: "permissions matrix",
    },
    security: { targetType: "security", nodeName: "security" },
    settings: { targetType: "settings", nodeName: "settings" },
    apps: { targetType: "containers", nodeName: "containers" },
    analytics: { targetType: "analytics", nodeName: "analytics" },
    earnings: { targetType: "earnings", nodeName: "earnings" },
    affiliates: { targetType: "affiliates", nodeName: "affiliates" },
    documents: { targetType: "documents", nodeName: "knowledge" },
    "api-explorer": { targetType: "health", nodeName: "health" },
    account: { targetType: "profile", nodeName: "profile" },
    "my-agents": { targetType: "agents", nodeName: "agents" },
    "admin/infrastructure": {
      targetType: "adminInfrastructure",
      nodeName: "admin infrastructure",
    },
    "admin/rpc-status": { targetType: "adminRpc", nodeName: "rpc status" },
    "admin/metrics": { targetType: "adminMetrics", nodeName: "admin metrics" },
  };

  if (exactMappings[subPath]) {
    return exactMappings[subPath];
  }

  // Prefix matching rules
  if (subPath.startsWith("agents")) {
    return { targetType: "agents", nodeName: "agents" };
  }
  if (subPath.startsWith("billing")) {
    return { targetType: "billing", nodeName: "billing" };
  }
  if (subPath.startsWith("admin")) {
    return { targetType: "admin", nodeName: "admin panel" };
  }

  // Programmatic fallback for custom nested paths
  const parts = subPath.split("/").flatMap((p) => p.split("-"));
  const nodeName = parts.join(" ");
  const targetType = parts
    .map((part, idx) => {
      if (idx === 0) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");

  return { targetType, nodeName };
}

export function CanvasLayout() {
  const {
    canvasOpen,
    setCanvasOpen,
    views,
    activeViewId,
    openView,
    maximizeNode,
  } = useCanvasStore();
  const location = useLocation();

  useEffect(() => {
    const routeInfo = pathToNodeType(location.pathname);
    if (!routeInfo) return;

    const { targetType, nodeName } = routeInfo;

    // 1. Ensure canvas is open
    if (!canvasOpen) {
      setCanvasOpen(true);
    }

    // 2. Open / Focus / Maximize
    const activeTab = views.find((v) => v.id === activeViewId);
    const existingNode = activeTab?.nodes?.find((n) => n.type === targetType);

    if (existingNode) {
      if (!existingNode.isMaximized) {
        maximizeNode(activeViewId!, existingNode.id, true);
      }
    } else {
      openView(nodeName, targetType, null, null);
      // Wait briefly for state to update, then maximize
      setTimeout(() => {
        const updatedState = useCanvasStore.getState();
        const tab = updatedState.views.find(
          (v) => v.id === updatedState.activeViewId,
        );
        const newNode = tab?.nodes?.find((n) => n.type === targetType);
        if (newNode && !newNode.isMaximized) {
          updatedState.maximizeNode(
            updatedState.activeViewId!,
            newNode.id,
            true,
          );
        }
      }, 50);
    }
  }, [
    location.pathname,
    canvasOpen,
    views,
    activeViewId,
    setCanvasOpen,
    openView,
    maximizeNode,
  ]);

  return (
    <TooltipProvider>
      <PageHeaderProvider>
        <div className="relative h-dvh w-full overflow-hidden bg-[#09090b]">
          {/* ── Layer 1: Canvas (always mounted) ── */}
          <div className="absolute inset-0">
            <CloudCanvas />
          </div>

          {/* ── Orb (always visible) ── */}
          <CloudAssistantPill />
        </div>
      </PageHeaderProvider>
    </TooltipProvider>
  );
}
