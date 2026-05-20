import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DagNode } from './DagNode';
import { DAG_EDGES, DAG_NODES, PHASE_COLORS } from './dag-definition';
import { MarketPanel } from './MarketPanel';
import { NodeDetailPanel } from './NodeDetailPanel';
import type {
  LLMCallFull,
  NPCTrajectory,
  TraceData,
  TraceNodeData,
  TraceSummary,
} from './types';

const nodeTypes = { dagNode: DagNode };
const W = 190;
const H = 72;

const API = 'http://localhost:4001';

async function fetchTraceList(): Promise<TraceSummary[]> {
  try {
    const r = await fetch(`${API}/traces`);
    return (await r.json()) as TraceSummary[];
  } catch {
    return [];
  }
}

async function fetchTrace(dir: string): Promise<TraceData | null> {
  try {
    const r = await fetch(`${API}/traces/${dir}`);
    return (await r.json()) as TraceData;
  } catch {
    return null;
  }
}

// Nodes that an NPC participates in
const NPC_RELEVANT_NODES = new Set([
  'market-decisions',
  'trade-execution',
  'price-updates',
  'rebalancing',
  'relationships',
  'group-dynamics',
]);

function buildGraph(
  traceNodes: TraceNodeData[],
  selectedNPC: NPCTrajectory | null
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    nodesep: 30,
    ranksep: 65,
    marginx: 20,
    marginy: 20,
  });

  const traceMap = new Map(traceNodes.map((n) => [n.nodeId, n]));
  const completed = new Set(
    traceNodes
      .filter((n) => n.status === 'success' || n.status === 'error')
      .map((n) => n.nodeId)
  );

  const validIds = new Set(DAG_NODES.map((n) => n.id));
  for (const dn of DAG_NODES) g.setNode(dn.id, { width: W, height: H });
  for (const e of DAG_EDGES) {
    if (
      validIds.has(e.source) &&
      validIds.has(e.target) &&
      e.source !== e.target
    )
      g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const flowNodes: Node[] = DAG_NODES.map((dn) => {
    const pos = g.node(dn.id);
    const t = traceMap.get(dn.id);
    const isNPCRelevant = selectedNPC != null && NPC_RELEVANT_NODES.has(dn.id);

    return {
      id: dn.id,
      type: 'dagNode',
      position: { x: (pos?.x ?? 0) - W / 2, y: (pos?.y ?? 0) - H / 2 },
      data: {
        label: dn.name,
        phase: dn.phase,
        phaseColor: PHASE_COLORS[dn.phase] ?? '#6b7280',
        description: dn.description,
        status: t?.status ?? 'pending',
        durationMs: t?.durationMs ?? 0,
        llmCallCount: t?.llmCallIds?.length ?? 0,
        hasError: t?.status === 'error',
        isCompleted: completed.has(dn.id),
        isAgent: false,
        isHighlighted: isNPCRelevant,
      },
    };
  });

  const flowEdges: Edge[] = DAG_EDGES.filter(
    (e) =>
      validIds.has(e.source) && validIds.has(e.target) && e.source !== e.target
  ).map((e, i) => {
    const both = completed.has(e.source) && completed.has(e.target);
    // Highlight edges on the NPC's path
    const onNPCPath =
      selectedNPC != null &&
      NPC_RELEVANT_NODES.has(e.source) &&
      NPC_RELEVANT_NODES.has(e.target);

    return {
      id: `e${i}`,
      source: e.source,
      target: e.target,
      label: e.label || undefined,
      animated: both,
      style: {
        stroke: onNPCPath ? '#ec4899' : both ? '#3b82f6' : '#334155',
        strokeWidth: onNPCPath ? 3 : both ? 2 : 1.2,
      },
      labelStyle: { fontSize: 9, fill: onNPCPath ? '#ec4899' : '#64748b' },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

// ============================================================
export function App() {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [selNodeId, setSelNodeId] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [selectedNPCId, setSelectedNPCId] = useState<string | null>(null);
  const lastRef = useRef<string | null>(null);
  const userPicked = useRef(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const selectedNPC = useMemo(() => {
    if (!selectedNPCId || !trace?.npcTrajectories) return null;
    return trace.npcTrajectories.find((n) => n.npcId === selectedNPCId) ?? null;
  }, [selectedNPCId, trace]);

  // Poll trace list
  const refresh = useCallback(async () => {
    const list = await fetchTraceList();
    setTraces(list);
    if (list.length > 0) {
      const newest = list[0]!.dirName;
      if (live && !userPicked.current && newest !== lastRef.current) {
        lastRef.current = newest;
        setSelected(newest);
      } else if (!selected) {
        setSelected(newest);
      }
    }
  }, [live, selected]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [live, refresh]);

  // Load trace
  useEffect(() => {
    if (!selected) return;
    fetchTrace(selected).then((d) => {
      if (!d) return;
      setTrace(d);
    });
  }, [selected]);

  // Rebuild graph when trace or selected NPC changes
  useEffect(() => {
    if (!trace) return;
    const g = buildGraph(trace.nodes, selectedNPC);
    setNodes(g.nodes);
    setEdges(g.edges);
  }, [trace, selectedNPC, setNodes, setEdges]);

  // Selected node
  const selNode = useMemo(() => {
    if (!selNodeId || !trace) return null;
    return trace.nodes.find((n) => n.nodeId === selNodeId) ?? null;
  }, [selNodeId, trace]);

  const selLLM = useMemo(() => {
    if (!selNode || !trace?.llmCallsFull) return [];
    const ids = new Set(selNode.llmCallIds);
    return trace.llmCallsFull.filter((c) => ids.has(c.callId)) as LLMCallFull[];
  }, [selNode, trace]);

  // NPCs to show in detail panel - just the selected one, or all if viewing a relevant node
  const detailNPCs = useMemo(() => {
    if (selectedNPC) return [selectedNPC];
    return trace?.npcTrajectories ?? [];
  }, [selectedNPC, trace]);

  const onNodeClick = useCallback(
    (_: unknown, n: Node) => setSelNodeId(n.id),
    []
  );
  const maxDur = Math.max(...(trace?.nodes ?? []).map((n) => n.durationMs), 1);

  // NPC stats for the dropdown
  const npcStats = useMemo(() => {
    if (!trace?.npcTrajectories)
      return { total: 0, trading: 0, holding: 0, failed: 0 };
    const npcs = trace.npcTrajectories;
    const trading = npcs.filter(
      (n) =>
        n.decisions?.[0]?.action !== 'hold' &&
        n.decisions?.[0]?.action !== 'wait'
    ).length;
    const holding = npcs.length - trading;
    const failed = npcs.filter((n) => n.trades?.some((t) => !t.success)).length;
    return { total: npcs.length, trading, holding, failed };
  }, [trace]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: '#0f172a',
      }}
    >
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        .react-flow__edge.animated path { stroke-dasharray:8; animation:dash .6s linear infinite }
        @keyframes dash { to{stroke-dashoffset:-16} }
      `}</style>

      {/* Header */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid #1e293b',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 700 }}>
          Babylon DAG
        </span>

        {/* Tick selector */}
        <select
          value={selected ?? ''}
          onChange={(e) => {
            userPicked.current = true;
            setSelected(e.target.value);
          }}
          style={selectStyle}
        >
          {traces.map((t) => (
            <option key={t.dirName} value={t.dirName}>
              {t.timestamp ? new Date(t.timestamp).toLocaleString() : t.dirName}
              {t.durationMs ? ` (${t.durationMs}ms)` : ''}
            </option>
          ))}
          {!traces.length && <option value="">No traces</option>}
        </select>

        {traces.length > 1 && (
          <>
            <button
              onClick={() => {
                const i = traces.findIndex((t) => t.dirName === selected);
                if (i < traces.length - 1) {
                  userPicked.current = true;
                  setSelected(traces[i + 1]!.dirName);
                }
              }}
              style={btnStyle}
            >
              &larr;
            </button>
            <button
              onClick={() => {
                const i = traces.findIndex((t) => t.dirName === selected);
                if (i > 0) {
                  userPicked.current = true;
                  setSelected(traces[i - 1]!.dirName);
                }
              }}
              style={btnStyle}
            >
              &rarr;
            </button>
          </>
        )}

        {/* Live toggle */}
        <button
          onClick={() =>
            setLive((p) => {
              if (!p) userPicked.current = false;
              return !p;
            })
          }
          style={{
            background: live ? '#16a34a22' : '#1e293b',
            border: `1px solid ${live ? '#16a34a' : '#334155'}`,
            borderRadius: 6,
            color: live ? '#4ade80' : '#94a3b8',
            padding: '3px 10px',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: live ? '#4ade80' : '#475569',
              animation: live ? 'pulse 2s infinite' : 'none',
            }}
          />
          {live ? 'LIVE' : 'PAUSED'}
        </button>

        {/* NPC selector */}
        {trace?.npcTrajectories && trace.npcTrajectories.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#ec4899', fontSize: 11, fontWeight: 600 }}>
              NPC:
            </span>
            <select
              value={selectedNPCId ?? ''}
              onChange={(e) => setSelectedNPCId(e.target.value || null)}
              style={{
                ...selectStyle,
                borderColor: selectedNPCId ? '#ec4899' : '#334155',
                color: selectedNPCId ? '#f9a8d4' : '#e2e8f0',
                minWidth: 180,
              }}
            >
              <option value="">
                All agents ({npcStats.total}: {npcStats.trading} trading,{' '}
                {npcStats.holding} hold, {npcStats.failed} failed)
              </option>
              {(trace.npcTrajectories ?? [])
                .slice()
                .sort((a, b) => a.npcName.localeCompare(b.npcName))
                .map((npc) => {
                  const action = npc.decisions?.[0]?.action ?? 'none';
                  const ticker = npc.decisions?.[0]?.ticker ?? '';
                  const failed = npc.trades?.some((t) => !t.success);
                  const label = `${npc.npcName} - ${action}${ticker ? ` ${ticker}` : ''}${failed ? ' FAIL' : ''}`;
                  return (
                    <option key={npc.npcId} value={npc.npcId}>
                      {label}
                    </option>
                  );
                })}
            </select>
          </div>
        )}

        {/* Stats */}
        {trace && (
          <div
            style={{
              color: '#94a3b8',
              fontSize: 11,
              marginLeft: 'auto',
              display: 'flex',
              gap: 12,
            }}
          >
            <span>
              {traces.findIndex((t) => t.dirName === selected) + 1}/
              {traces.length} ticks
            </span>
            <span>{trace.durationMs}ms</span>
            <span>LLM:{trace.llmCallSummaries?.length ?? 0}</span>
            <span>
              {(trace.tokenStats?.totalTokens ?? 0).toLocaleString()} tok
            </span>
            {trace.tokenStats?.estimatedCostUSD != null && (
              <span>${trace.tokenStats.estimatedCostUSD.toFixed(4)}</span>
            )}
            <span style={{ color: '#ec4899' }}>{npcStats.total} agents</span>
          </div>
        )}
      </div>

      {/* Selected NPC summary bar */}
      {selectedNPC && (
        <div
          style={{
            padding: '6px 16px',
            borderBottom: '1px solid #831843',
            background: '#1e1030',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            fontSize: 12,
          }}
        >
          <span style={{ color: '#f9a8d4', fontWeight: 700 }}>
            {selectedNPC.npcName}
          </span>
          {selectedNPC.decisions?.[0] && (
            <>
              <span style={{ color: '#ec4899' }}>
                {selectedNPC.decisions[0].action}
                {selectedNPC.decisions[0].ticker
                  ? ` ${selectedNPC.decisions[0].ticker}`
                  : ''}
                {selectedNPC.decisions[0].amount
                  ? ` $${selectedNPC.decisions[0].amount.toLocaleString()}`
                  : ''}
              </span>
              <span style={{ color: '#94a3b8' }}>
                {((selectedNPC.decisions[0].confidence ?? 0) * 100).toFixed(0)}%
                conf
              </span>
              <span style={{ color: '#cbd5e1', fontStyle: 'italic', flex: 1 }}>
                &ldquo;{selectedNPC.decisions[0].reasoning}&rdquo;
              </span>
            </>
          )}
          {selectedNPC.trades?.map((t, i) => (
            <span
              key={i}
              style={{
                color: t.success ? '#4ade80' : '#ef4444',
                fontWeight: 600,
              }}
            >
              {t.success ? 'FILLED' : `FAILED: ${t.error ?? 'unknown'}`}
            </span>
          ))}
        </div>
      )}

      {/* Timeline */}
      {trace && (
        <div
          style={{
            borderBottom: '1px solid #1e293b',
            padding: '4px 16px',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 2,
            height: 36,
          }}
        >
          {trace.nodes
            .filter((n) => n.status !== 'skipped')
            .map((n) => {
              const h = Math.max(3, (n.durationMs / maxDur) * 28);
              const c = PHASE_COLORS[n.phase] ?? '#6b7280';
              const isNPCNode =
                selectedNPC != null && NPC_RELEVANT_NODES.has(n.nodeId);
              return (
                <button
                  key={n.nodeId}
                  onClick={() => setSelNodeId(n.nodeId)}
                  title={`${n.name}: ${n.durationMs}ms`}
                  style={{
                    width: 14,
                    height: h,
                    background:
                      n.status === 'error'
                        ? '#ef4444'
                        : isNPCNode
                          ? '#ec4899'
                          : c,
                    borderRadius: '2px 2px 0 0',
                    border: 'none',
                    cursor: 'pointer',
                    opacity: 0.8,
                    padding: 0,
                  }}
                />
              );
            })}
        </div>
      )}

      {/* Main */}
      <div style={{ flex: 1, display: 'flex' }}>
        {!trace ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#94a3b8',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 16, color: '#e2e8f0' }}>
              No trace data yet
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              Run:{' '}
              <code
                style={{
                  background: '#1e293b',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                BABYLON_DAG_TRACE=true bun run scripts/run-traced-tick.ts
              </code>
            </div>
          </div>
        ) : (
          <>
            {/* Left: Markets */}
            <MarketPanel trace={trace} selectedNPC={selectedNPC} />

            {/* Center: DAG */}
            <div style={{ flex: 1 }}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                nodeTypes={nodeTypes}
                fitView
                minZoom={0.25}
                maxZoom={2.5}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#1e293b" gap={20} />
                <Controls
                  style={{ background: '#1e293b', borderColor: '#334155' }}
                />
                <MiniMap
                  style={{ background: '#1e293b' }}
                  nodeColor={(n) =>
                    (n.data as Record<string, string>).phaseColor ?? '#6b7280'
                  }
                  maskColor="rgba(0,0,0,.6)"
                />
              </ReactFlow>
            </div>

            {/* Right: Node Details */}
            {selNode && (
              <NodeDetailPanel
                node={selNode}
                llmCalls={selLLM}
                npcs={detailNPCs}
                onClose={() => setSelNodeId(null)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 4,
  color: '#e2e8f0',
  padding: '3px 6px',
  fontSize: 12,
  minWidth: 220,
};

const btnStyle: React.CSSProperties = {
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 4,
  color: '#e2e8f0',
  padding: '3px 8px',
  cursor: 'pointer',
  fontSize: 12,
};
