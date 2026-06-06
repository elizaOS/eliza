"use client";

import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DagNode } from "./DagNode";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { TickSelector } from "./TickSelector";
import { TickTimeline } from "./TickTimeline";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHASE_COLORS: Record<string, string> = {
  Bootstrap: "#3b82f6",
  Questions: "#06b6d4",
  Events: "#f97316",
  Markets: "#22c55e",
  Rebalancing: "#eab308",
  ContentMaintenance: "#6b7280",
  Social: "#a855f7",
  Finalize: "#ef4444",
};

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;
const nodeTypes = { dagNode: DagNode };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TraceSummary {
  dirName: string;
  tickId: string;
  tickNumber?: number;
  timestamp?: string;
  durationMs?: number;
  nodeCount?: number;
  llmCallCount?: number;
  npcTrajectoryCount?: number;
}

interface TraceNodeData {
  nodeId: string;
  name: string;
  phase: string;
  phaseNumber: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: "success" | "error" | "skipped";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error?: string;
  llmCallIds: string[];
}

interface TraceData {
  tickId: string;
  tickNumber: number;
  timestamp: string;
  durationMs: number;
  dag: {
    nodes: Array<{
      id: string;
      name: string;
      phase: string;
      phaseNumber: number;
      description: string;
    }>;
    edges: Array<{ source: string; target: string; label: string }>;
  };
  nodes: TraceNodeData[];
  llmCallSummaries: Array<{
    callId: string;
    nodeId: string;
    promptType: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    success: boolean;
  }>;
  llmCallsFull?: Array<Record<string, unknown>>;
  npcTrajectories?: Array<Record<string, unknown>>;
  tokenStats: {
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    estimatedCostUSD: number;
  };
  gameTickResult: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function layoutDag(
  dagNodes: TraceData["dag"]["nodes"],
  dagEdges: TraceData["dag"]["edges"],
  traceNodes: TraceData["nodes"],
  activeNodeIds?: Set<string>,
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 80 });

  const traceMap = new Map(traceNodes.map((n) => [n.nodeId, n]));
  const validNodeIds = new Set(dagNodes.map((n) => n.id));

  for (const dn of dagNodes) {
    g.setNode(dn.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of dagEdges) {
    if (
      validNodeIds.has(edge.source) &&
      validNodeIds.has(edge.target) &&
      edge.source !== edge.target
    ) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  const completedNodes = new Set(
    traceNodes
      .filter((n) => n.status === "success" || n.status === "error")
      .map((n) => n.nodeId),
  );

  const flowNodes: Node[] = dagNodes.map((dn) => {
    const pos = g.node(dn.id);
    const trace = traceMap.get(dn.id);
    const isActive = activeNodeIds?.has(dn.id) ?? false;
    const isCompleted = completedNodes.has(dn.id);

    return {
      id: dn.id,
      type: "dagNode",
      position: {
        x: (pos?.x ?? 0) - NODE_WIDTH / 2,
        y: (pos?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: {
        label: dn.name,
        phase: dn.phase,
        phaseColor: PHASE_COLORS[dn.phase] ?? "#6b7280",
        description: dn.description,
        status: trace?.status ?? "skipped",
        durationMs: trace?.durationMs ?? 0,
        llmCallCount: trace?.llmCallIds?.length ?? 0,
        hasError: trace?.status === "error",
        isActive,
        isCompleted,
      },
    };
  });

  const flowEdges: Edge[] = dagEdges
    .filter(
      (e) =>
        validNodeIds.has(e.source) &&
        validNodeIds.has(e.target) &&
        e.source !== e.target,
    )
    .map((e, i) => {
      // Animate edges that connect completed -> active nodes
      const sourceCompleted = completedNodes.has(e.source);
      const targetActive = activeNodeIds?.has(e.target) ?? false;
      const bothCompleted =
        completedNodes.has(e.source) && completedNodes.has(e.target);
      const isFlowing = sourceCompleted && targetActive;

      return {
        id: `edge-${i}`,
        source: e.source,
        target: e.target,
        label: e.label || undefined,
        animated: isFlowing,
        style: {
          stroke: isFlowing ? "#4ade80" : bothCompleted ? "#3b82f6" : "#334155",
          strokeWidth: isFlowing ? 2.5 : bothCompleted ? 2 : 1.5,
        },
        labelStyle: {
          fontSize: 10,
          fill: isFlowing ? "#4ade80" : "#64748b",
        },
      };
    });

  return { nodes: flowNodes, edges: flowEdges };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DagVisualizerClient() {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [traceData, setTraceData] = useState<TraceData | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveMode, setLiveMode] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const [tickRunning, setTickRunning] = useState(false);
  const [tickStatus, setTickStatus] = useState("");

  const lastKnownTraceRef = useRef<string | null>(null);
  const userSelectedRef = useRef(false);
  const sseRef = useRef<EventSource | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // -----------------------------------------------------------------------
  // SSE live connection
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!liveMode) {
      sseRef.current?.close();
      sseRef.current = null;
      setSseConnected(false);
      return;
    }

    const es = new EventSource("/api/admin/dag-traces/live");
    sseRef.current = es;

    es.addEventListener("connected", () => {
      setSseConnected(true);
    });

    es.addEventListener("new-trace", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        // Add to traces list at the top
        setTraces((prev) => {
          const exists = prev.some((t) => t.dirName === data.dirName);
          if (exists) return prev;
          return [
            {
              dirName: data.dirName,
              tickId: data.tickId,
              tickNumber: data.tickNumber,
              timestamp: data.timestamp,
              durationMs: data.durationMs,
              nodeCount: data.nodeCount,
              llmCallCount: data.llmCallCount,
            },
            ...prev,
          ];
        });

        // Auto-select if in live mode and user hasn't manually picked
        if (!userSelectedRef.current) {
          lastKnownTraceRef.current = data.dirName;
          setSelectedTrace(data.dirName);

          // If SSE sent inline node data, use it directly (faster)
          if (data.nodes && data.dag) {
            setTraceData(data as TraceData);
            const layout = layoutDag(
              data.dag.nodes,
              data.dag.edges,
              data.nodes,
            );
            setNodes(layout.nodes);
            setEdges(layout.edges);
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("heartbeat", () => {
      setSseConnected(true);
    });

    es.onerror = () => {
      setSseConnected(false);
    };

    return () => {
      es.close();
      sseRef.current = null;
      setSseConnected(false);
    };
  }, [liveMode, setNodes, setEdges]);

  // -----------------------------------------------------------------------
  // Fetch trace list (initial + fallback polling when SSE not available)
  // -----------------------------------------------------------------------
  const fetchTraceList = useCallback(() => {
    fetch("/api/admin/dag-traces")
      .then((r) => r.json())
      .then((data) => {
        const list: TraceSummary[] = data.data?.traces ?? data.traces ?? [];
        setTraces(list);

        if (list.length > 0) {
          const newest = list[0]?.dirName;
          if (!newest) return;
          if (
            liveMode &&
            !userSelectedRef.current &&
            newest !== lastKnownTraceRef.current
          ) {
            lastKnownTraceRef.current = newest;
            setSelectedTrace(newest);
          } else if (!selectedTrace) {
            setSelectedTrace(newest);
          }
        }
      })
      .catch(() => {});
  }, [liveMode, selectedTrace]);

  useEffect(() => {
    fetchTraceList();
  }, [fetchTraceList]);

  // Fallback polling when SSE is not connected
  useEffect(() => {
    if (!liveMode || sseConnected) return;
    const interval = setInterval(fetchTraceList, 5000);
    return () => clearInterval(interval);
  }, [liveMode, sseConnected, fetchTraceList]);

  // -----------------------------------------------------------------------
  // Fetch full trace data when selected
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!selectedTrace) return;
    setLoading(true);
    fetch(`/api/admin/dag-traces/${selectedTrace}?include=llm-calls,npc`)
      .then((r) => r.json())
      .then((data) => {
        const trace: TraceData = data.data ?? data;
        setTraceData(trace);
        if (trace.dag && trace.nodes) {
          const layout = layoutDag(
            trace.dag.nodes,
            trace.dag.edges,
            trace.nodes,
          );
          setNodes(layout.nodes);
          setEdges(layout.edges);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedTrace, setNodes, setEdges]);

  // -----------------------------------------------------------------------
  // Trigger a game tick
  // -----------------------------------------------------------------------
  const triggerTick = useCallback(async () => {
    if (tickRunning) return;
    setTickRunning(true);
    setTickStatus("Executing game tick...");
    userSelectedRef.current = false; // auto-follow the new trace

    try {
      const res = await fetch("/api/admin/dag-traces/trigger-tick", {
        method: "POST",
      });
      const data = await res.json();
      if (data.data?.success || data.success) {
        setTickStatus(
          `Tick complete (${data.data?.durationMs ?? data.durationMs}ms)`,
        );
        // Refresh trace list
        fetchTraceList();
      } else {
        setTickStatus(`Tick failed: ${JSON.stringify(data).slice(0, 120)}`);
      }
    } catch (err) {
      setTickStatus(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setTickRunning(false);
      setTimeout(() => setTickStatus(""), 8000);
    }
  }, [tickRunning, fetchTraceList]);

  // -----------------------------------------------------------------------
  // User interaction handlers
  // -----------------------------------------------------------------------
  const handleUserSelect = useCallback((dirName: string) => {
    userSelectedRef.current = true;
    setSelectedTrace(dirName);
  }, []);

  const handleToggleLive = useCallback(() => {
    setLiveMode((prev) => {
      if (!prev) {
        userSelectedRef.current = false;
        const newest = traces[0]?.dirName;
        if (newest) {
          setSelectedTrace(newest);
        }
      }
      return !prev;
    });
  }, [traces]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId || !traceData) return null;
    return traceData.nodes.find((n) => n.nodeId === selectedNodeId) ?? null;
  }, [selectedNodeId, traceData]);

  const selectedNodeLLMCalls = useMemo(() => {
    if (!selectedNode || !traceData?.llmCallsFull) return [];
    const callIds = new Set(selectedNode.llmCallIds);
    return traceData.llmCallsFull.filter((c) =>
      callIds.has(c.callId as string),
    );
  }, [selectedNode, traceData]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#0f172a",
      }}
    >
      {/* Global animations */}
      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .react-flow__edge.animated path { stroke-dasharray: 8; animation: dashmove 0.6s linear infinite; }
        @keyframes dashmove { to { stroke-dashoffset: -16; } }
      `}</style>

      {/* Header */}
      <div
        style={{
          padding: "10px 20px",
          borderBottom: "1px solid #1e293b",
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: "#0f172a",
        }}
      >
        <h1
          style={{
            color: "#f1f5f9",
            fontSize: 18,
            fontWeight: 700,
            margin: 0,
          }}
        >
          DAG Visualizer
        </h1>

        <TickSelector
          traces={traces}
          selected={selectedTrace}
          onSelect={handleUserSelect}
        />

        {/* Live toggle */}
        <button
          type="button"
          onClick={handleToggleLive}
          style={{
            background: liveMode ? "#16a34a22" : "#1e293b",
            border: `1px solid ${liveMode ? "#16a34a" : "#334155"}`,
            borderRadius: 6,
            color: liveMode ? "#4ade80" : "#94a3b8",
            padding: "4px 12px",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: liveMode
                ? sseConnected
                  ? "#4ade80"
                  : "#eab308"
                : "#475569",
              display: "inline-block",
              animation: liveMode ? "pulse 2s infinite" : "none",
            }}
          />
          {liveMode ? (sseConnected ? "LIVE" : "CONNECTING") : "PAUSED"}
        </button>

        {/* Trigger tick */}
        <button
          type="button"
          onClick={triggerTick}
          disabled={tickRunning}
          style={{
            background: tickRunning ? "#1e293b" : "#7c3aed22",
            border: `1px solid ${tickRunning ? "#334155" : "#7c3aed"}`,
            borderRadius: 6,
            color: tickRunning ? "#94a3b8" : "#c4b5fd",
            padding: "4px 14px",
            cursor: tickRunning ? "not-allowed" : "pointer",
            fontSize: 12,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {tickRunning ? (
            <span
              style={{
                width: 12,
                height: 12,
                border: "2px solid #7c3aed",
                borderTopColor: "transparent",
                borderRadius: "50%",
                display: "inline-block",
                animation: "spin 0.8s linear infinite",
              }}
            />
          ) : (
            "\u25B6"
          )}
          {tickRunning ? "Running..." : "Run Tick"}
        </button>

        {tickStatus && (
          <span style={{ color: "#94a3b8", fontSize: 12 }}>{tickStatus}</span>
        )}

        {/* Stats */}
        {traceData && (
          <div
            style={{
              color: "#94a3b8",
              fontSize: 12,
              marginLeft: "auto",
              display: "flex",
              gap: 14,
            }}
          >
            <span>
              {traces.findIndex((t) => t.dirName === selectedTrace) + 1}/
              {traces.length}
            </span>
            <span>{traceData.durationMs}ms</span>
            <span>LLM:{traceData.llmCallSummaries?.length ?? 0}</span>
            <span>
              {(traceData.tokenStats?.totalTokens ?? 0).toLocaleString()} tok
            </span>
            {traceData.tokenStats?.estimatedCostUSD != null && (
              <span>${traceData.tokenStats.estimatedCostUSD.toFixed(4)}</span>
            )}
          </div>
        )}
      </div>

      {/* Timeline bar */}
      {traceData && (
        <div style={{ borderBottom: "1px solid #1e293b", padding: "6px 20px" }}>
          <TickTimeline
            nodes={traceData.nodes}
            onNodeClick={setSelectedNodeId}
          />
        </div>
      )}

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", position: "relative" }}>
        {loading ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#94a3b8",
              gap: 8,
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                border: "2px solid #3b82f6",
                borderTopColor: "transparent",
                borderRadius: "50%",
                display: "inline-block",
                animation: "spin 0.8s linear infinite",
              }}
            />
            Loading trace data...
          </div>
        ) : !traceData ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#94a3b8",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div style={{ fontSize: 18, color: "#e2e8f0" }}>
              No trace data yet
            </div>
            <div style={{ fontSize: 13, color: "#64748b" }}>
              Click <strong>Run Tick</strong> to execute a game tick with full
              tracing, or enable FEED_DAG_TRACE=true
            </div>
            <button
              type="button"
              onClick={triggerTick}
              disabled={tickRunning}
              style={{
                background: "#7c3aed",
                border: "none",
                borderRadius: 8,
                color: "#fff",
                padding: "10px 24px",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {tickRunning ? "Running..." : "Run Game Tick"}
            </button>
          </div>
        ) : (
          <>
            {/* Graph */}
            <div style={{ flex: 1 }}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                nodeTypes={nodeTypes}
                fitView
                minZoom={0.3}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#1e293b" gap={20} />
                <Controls
                  style={{ background: "#1e293b", borderColor: "#334155" }}
                />
                <MiniMap
                  style={{ background: "#1e293b" }}
                  nodeColor={(n: Node) =>
                    (n.data as Record<string, string>).phaseColor ?? "#6b7280"
                  }
                  maskColor="rgba(0,0,0,0.6)"
                />
              </ReactFlow>
            </div>

            {/* Detail panel */}
            {selectedNode && (
              <NodeDetailPanel
                node={selectedNode}
                llmCalls={selectedNodeLLMCalls}
                npcTrajectories={traceData.npcTrajectories ?? []}
                onClose={() => setSelectedNodeId(null)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
