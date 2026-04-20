/**
 * WorkflowGraphViewer — React Flow graph for n8n workflow visualisation.
 *
 * Renders nodes and edges from an N8nWorkflow object. Supports a live
 * "generating" mode that pulses the border and shows a spinner overlay while
 * the agent is constructing the workflow via CREATE_N8N_WORKFLOW.
 *
 * Layer: feature (packages/app-core/src/components/pages/)
 */

import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { Maximize2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@elizaos/ui";
import type { N8nConnectionMap, N8nWorkflow } from "../../api/client-types-chat";

// ── Node type colour families ─────────────────────────────────────────────────

function resolveNodeColor(type: string): {
  bg: string;
  border: string;
  badge: string;
} {
  const t = type.toLowerCase();
  if (
    t.includes("trigger") ||
    t.includes("webhook") ||
    t.includes("schedule") ||
    t.includes("cron")
  ) {
    return { bg: "#451a03", border: "#f59e0b", badge: "#f59e0b" }; // amber — trigger
  }
  if (
    t.includes("if") ||
    t.includes("switch") ||
    t.includes("merge") ||
    t.includes("split") ||
    t.includes("wait") ||
    t.includes("noop") ||
    t.includes("start")
  ) {
    return { bg: "#1e293b", border: "#64748b", badge: "#64748b" }; // slate — flow-control
  }
  if (
    t.includes("gmail") ||
    t.includes("slack") ||
    t.includes("telegram") ||
    t.includes("discord") ||
    t.includes("github") ||
    t.includes("notion") ||
    t.includes("google") ||
    t.includes("openai") ||
    t.includes("anthropic")
  ) {
    return { bg: "#2e1065", border: "#8b5cf6", badge: "#8b5cf6" }; // violet — integration
  }
  // Default: action (blue)
  return { bg: "#0c1a2e", border: "#3b82f6", badge: "#3b82f6" };
}

// ── Auto layout ──────────────────────────────────────────────────────────────

const NODE_WIDTH = 180;
const NODE_HEIGHT = 64;
const H_GAP = 60;
const V_GAP = 40;

function autoLayoutPositions(
  nodeNames: string[],
): Map<string, { x: number; y: number }> {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodeNames.length)));
  const positions = new Map<string, { x: number; y: number }>();
  nodeNames.forEach((name, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(name, {
      x: col * (NODE_WIDTH + H_GAP) + 40,
      y: row * (NODE_HEIGHT + V_GAP) + 40,
    });
  });
  return positions;
}

// ── Conversion helpers ────────────────────────────────────────────────────────

function workflowToReactFlow(workflow: N8nWorkflow | null): {
  nodes: Node[];
  edges: Edge[];
} {
  if (!workflow?.nodes?.length) return { nodes: [], edges: [] };

  const rawNodes = workflow.nodes;

  // Collect position overrides from n8n canvas coordinates
  const posOverrides = new Map<string, { x: number; y: number }>();
  for (const n of rawNodes) {
    if (n.position) {
      posOverrides.set(n.name, { x: n.position[0], y: n.position[1] });
    }
  }

  // Fall back to auto-layout for any node missing a position
  const missing = rawNodes
    .filter((n) => !posOverrides.has(n.name))
    .map((n) => n.name);
  const autoPos = autoLayoutPositions(missing);

  const nodes: Node[] = rawNodes.map((n) => {
    const pos = posOverrides.get(n.name) ?? autoPos.get(n.name) ?? { x: 0, y: 0 };
    const colors = resolveNodeColor(n.type ?? "");
    const typeLabel = (n.type ?? "node").split(".").pop() ?? "node";
    return {
      id: n.id ?? n.name,
      position: pos,
      data: {
        label: n.name,
        typeLabel,
        colors,
      },
      style: {
        background: colors.bg,
        border: `1.5px solid ${colors.border}`,
        borderRadius: "8px",
        padding: "8px 12px",
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        color: "#e2e8f0",
        fontSize: "12px",
        boxShadow: `0 0 0 1px ${colors.border}22`,
      },
    };
  });

  // Build a name -> id map for connection edge lookups
  const nameToId = new Map<string, string>();
  for (const n of rawNodes) {
    nameToId.set(n.name, n.id ?? n.name);
  }

  const edges: Edge[] = [];
  const connections: N8nConnectionMap = workflow.connections ?? {};
  for (const [sourceName, outputMap] of Object.entries(connections)) {
    const sourceId = nameToId.get(sourceName);
    if (!sourceId) continue;
    const mainOutputs = outputMap.main ?? [];
    mainOutputs.forEach((outputIndex, oi) => {
      (outputIndex ?? []).forEach((conn, ci) => {
        const targetId = nameToId.get(conn.node);
        if (!targetId) return;
        edges.push({
          id: `${sourceId}-${targetId}-${oi}-${ci}`,
          source: sourceId,
          target: targetId,
          type: "smoothstep",
          animated: false,
          style: {
            stroke: "#475569",
            strokeWidth: 1.5,
          },
        });
      });
    });
  }

  return { nodes, edges };
}

function generatingEdges(edges: Edge[]): Edge[] {
  return edges.map((e) => ({
    ...e,
    animated: true,
    style: {
      ...e.style,
      stroke: "#3b82f6",
      strokeDasharray: "6 3",
    },
  }));
}

// ── Graph panel (shared between inline and full-screen modal) ─────────────────

function GraphPanel({
  nodes,
  edges,
  isGenerating,
  ariaLabel,
}: {
  nodes: Node[];
  edges: Edge[];
  isGenerating: boolean;
  ariaLabel: string;
}) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={isGenerating ? generatingEdges(edges) : edges}
      nodesDraggable={!isGenerating}
      nodesConnectable={false}
      edgesReconnectable={false}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
      proOptions={{ hideAttribution: true }}
      aria-label={ariaLabel}
    >
      <Background color="#334155" gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        nodeColor={(n) => {
          const colors = (n.data as { colors?: { border: string } })?.colors;
          return colors?.border ?? "#475569";
        }}
        maskColor="rgba(2, 8, 23, 0.7)"
        style={{ background: "#0f172a", border: "1px solid #334155" }}
      />
    </ReactFlow>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface WorkflowGraphViewerProps {
  workflow: N8nWorkflow | null;
  loading?: boolean;
  isGenerating?: boolean;
  onNodeClick?: (nodeName: string) => void;
  /** Ref to the chat composer textarea, used by the empty-state CTA. */
  composerRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function WorkflowGraphViewer({
  workflow,
  loading = false,
  isGenerating = false,
  onNodeClick,
  composerRef,
}: WorkflowGraphViewerProps) {
  const [fullScreen, setFullScreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { nodes, edges } = useMemo(
    () => workflowToReactFlow(workflow),
    [workflow],
  );

  const ariaLabel = `Workflow graph with ${nodes.length} nodes and ${edges.length} connections`;

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const label = (node.data as { label?: string })?.label ?? node.id;
      onNodeClick?.(label);
    },
    [onNodeClick],
  );

  // Trap focus in full-screen modal with Escape to close
  useEffect(() => {
    if (!fullScreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fullScreen]);

  const hasNodes = nodes.length > 0;

  const borderClass = isGenerating
    ? "animate-pulse ring-2 ring-blue-500/50"
    : "ring-1 ring-border/30";

  return (
    <>
      <div
        ref={containerRef}
        role="img"
        aria-label={ariaLabel}
        className={`relative overflow-hidden rounded-lg bg-[#020817] ${borderClass}`}
        style={{ height: 420 }}
      >
        {/* Loading skeleton */}
        {loading && !hasNodes && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner className="h-6 w-6 text-muted" />
          </div>
        )}

        {/* Empty state */}
        {!loading && !hasNodes && !isGenerating && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm font-medium text-muted">No nodes yet</p>
            <p className="text-xs text-muted/60">
              Ask the Automations Assistant to build one.
            </p>
            {composerRef && (
              <button
                type="button"
                className="mt-1 rounded-md border border-border/40 bg-bg/40 px-3 py-1.5 text-xs text-txt hover:bg-bg/70 transition-colors"
                onClick={() => composerRef.current?.focus()}
              >
                Open chat
              </button>
            )}
          </div>
        )}

        {/* Generating overlay on top of graph */}
        {isGenerating && (
          <div className="absolute inset-0 z-10 flex items-center justify-center backdrop-blur-[1px]">
            <div className="flex items-center gap-2 rounded-full border border-blue-500/30 bg-[#020817]/80 px-4 py-2 text-sm text-blue-400">
              <Spinner className="h-4 w-4" />
              Building workflow...
            </div>
          </div>
        )}

        {/* The graph (render even with 0 nodes so React Flow mounts cleanly) */}
        {!loading && (
          <div className="h-full w-full" onClick={(e) => e.stopPropagation()}>
            <ReactFlow
              nodes={nodes}
              edges={isGenerating ? generatingEdges(edges) : edges}
              nodesDraggable={!isGenerating}
              nodesConnectable={false}
              edgesReconnectable={false}
              onNodeClick={handleNodeClick}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
              proOptions={{ hideAttribution: true }}
              aria-label={ariaLabel}
            >
              <Background color="#334155" gap={20} size={1} />
              <Controls showInteractive={false} />
              {hasNodes && (
                <MiniMap
                  nodeColor={(n) => {
                    const colors = (n.data as { colors?: { border: string } })?.colors;
                    return colors?.border ?? "#475569";
                  }}
                  maskColor="rgba(2, 8, 23, 0.7)"
                  style={{
                    background: "#0f172a",
                    border: "1px solid #334155",
                  }}
                />
              )}
            </ReactFlow>
          </div>
        )}

        {/* Full-screen toggle button */}
        {hasNodes && !isGenerating && (
          <button
            type="button"
            aria-label="Full screen"
            className="absolute right-3 top-3 z-20 flex h-7 w-7 items-center justify-center rounded border border-border/40 bg-bg/80 text-muted hover:text-txt transition-colors"
            onClick={() => setFullScreen(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Full-screen dialog */}
      <Dialog open={fullScreen} onOpenChange={setFullScreen}>
        <DialogContent
          className="h-[90dvh] w-[90vw] !max-w-none !max-h-none flex flex-col p-0 gap-0"
          showCloseButton={false}
        >
          <DialogHeader className="flex flex-row items-center justify-between border-b border-border/30 px-4 py-3 shrink-0">
            <DialogTitle className="text-sm font-medium">
              {workflow?.name ?? "Workflow Graph"}
            </DialogTitle>
            <button
              type="button"
              aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded text-muted hover:text-txt transition-colors"
              onClick={() => setFullScreen(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-hidden bg-[#020817]">
            <GraphPanel
              nodes={nodes}
              edges={edges}
              isGenerating={isGenerating}
              ariaLabel={ariaLabel}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
