import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Spinner,
  StatusBadge,
} from "@elizaos/ui";
import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
} from "@xyflow/react";
import { ExternalLink, Maximize2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  WorkflowConnectionMap,
  WorkflowStatusResponse,
  WorkflowDefinition,
  WorkflowDefinitionNode,
} from "../../api/client-types-chat";
import { getBootConfig } from "../../config/boot-config";
import { useApp } from "../../state";

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

function workflowToReactFlow(workflow: WorkflowDefinition | null): {
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
    const pos = posOverrides.get(n.name) ??
      autoPos.get(n.name) ?? { x: 0, y: 0 };
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
  const connections: WorkflowConnectionMap = workflow.connections ?? {};
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

function graphChrome(uiTheme: "light" | "dark") {
  if (uiTheme === "light") {
    return {
      canvasBg: "#f8fafc",
      dots: "#cbd5e1",
      minimapMask: "rgba(226, 232, 240, 0.72)",
      minimapBg: "#ffffff",
      minimapBorder: "#cbd5e1",
      emptyTitleClass: "text-slate-700",
      emptyHelpClass: "text-slate-500",
      overlayBg: "rgba(248, 250, 252, 0.72)",
      overlayChipBg: "rgba(255, 255, 255, 0.94)",
      overlayChipText: "#1d4ed8",
    };
  }

  return {
    canvasBg: "#020817",
    dots: "#334155",
    minimapMask: "rgba(2, 8, 23, 0.7)",
    minimapBg: "#0f172a",
    minimapBorder: "#334155",
    emptyTitleClass: "text-slate-300",
    emptyHelpClass: "text-slate-500",
    overlayBg: "rgba(2, 8, 23, 0.6)",
    overlayChipBg: "rgba(2, 8, 23, 0.82)",
    overlayChipText: "#60a5fa",
  };
}

// ── Generation progress overlay ───────────────────────────────────────────────

/**
 * Stage messages for `WorkflowGenerationProgress`. The plugin's workflow
 * generation today is a single request/response, so the client cannot yet
 * observe the actual stage in real time. We cycle through plausible labels
 * on a fixed timer based on observed median latencies of each phase:
 *   1. extractKeywords (fast — runtime-context provider + keyword LLM call)
 *   2. searchNodes + credential filter + fetchRuntimeContext
 *   3. generateWorkflow (LLM, slowest)
 *   4. validateAndRepair + injectMissingCredentialBlocks
 *   5. deployWorkflow + resolveCredentials + activate
 *
 * When the plugin grows a server-sent-events streaming endpoint, the timer
 * can be replaced with real per-stage progress events.
 */
const WORKFLOW_GENERATION_STAGES: ReadonlyArray<{
  label: string;
  hint: string;
  /** Approximate seconds at which this stage takes over. */
  startsAt: number;
}> = [
  {
    label: "Understanding your prompt",
    hint: "Extracting keywords + matching providers",
    startsAt: 0,
  },
  {
    label: "Finding the right nodes",
    hint: "Searching catalog + checking credentials",
    startsAt: 3,
  },
  {
    label: "Generating workflow",
    hint: "Asking the LLM with runtime facts",
    startsAt: 6,
  },
  {
    label: "Validating + repairing",
    hint: "Clamping versions + auto-fixing references",
    startsAt: 18,
  },
  {
    label: "Deploying to n8n",
    hint: "Minting credentials + activating",
    startsAt: 24,
  },
  {
    label: "Almost done",
    hint: "Wrapping up — this is taking a bit longer than usual",
    startsAt: 35,
  },
];

function WorkflowGenerationProgress({
  chrome,
}: {
  chrome: ReturnType<typeof graphChrome>;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, []);

  const currentIndex = WORKFLOW_GENERATION_STAGES.reduce(
    (acc, stage, idx) => (elapsed >= stage.startsAt ? idx : acc),
    0,
  );

  return (
    <div
      className="w-full max-w-md rounded-xl border px-5 py-4 text-sm shadow-lg"
      style={{
        background: chrome.overlayChipBg,
        color: chrome.overlayChipText,
        borderColor: chrome.overlayChipText,
      }}
    >
      <div className="flex items-start gap-3">
        <Spinner className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="font-semibold">Building your workflow…</div>
            <div className="text-xs opacity-70">
              Generations usually take 10–30 seconds.
            </div>
          </div>
          <ol className="space-y-1.5">
            {WORKFLOW_GENERATION_STAGES.map((stage, idx) => {
              const isDone = idx < currentIndex;
              const isActive = idx === currentIndex;
              return (
                <li
                  key={stage.label}
                  className={`flex items-start gap-2 text-xs transition-opacity ${
                    isDone || isActive ? "opacity-100" : "opacity-40"
                  }`}
                >
                  <span
                    className={`mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                      isDone
                        ? "border-current bg-current/15"
                        : isActive
                          ? "border-current bg-current/15"
                          : "border-current/40"
                    }`}
                    aria-hidden
                  >
                    {isDone ? (
                      <svg
                        viewBox="0 0 12 12"
                        className="h-2.5 w-2.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        role="img"
                        aria-label="completed"
                      >
                        <path
                          d="M2.5 6.5l2.5 2.5 4.5-5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : isActive ? (
                      <span
                        className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
                        aria-hidden
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`font-medium ${isActive ? "" : "opacity-70"}`}
                    >
                      {stage.label}
                    </span>
                    {(isDone || isActive) && (
                      <span className="ml-1.5 opacity-60">— {stage.hint}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

// ── Node detail drawer ────────────────────────────────────────────────────────

const PARAM_TRUNCATE_LENGTH = 200;

function ParamValue({ value }: { value: unknown }) {
  const { t } = useApp();
  const [expanded, setExpanded] = useState(false);

  if (typeof value === "string") {
    if (value.length > PARAM_TRUNCATE_LENGTH && !expanded) {
      return (
        <span>
          <pre className="inline font-mono whitespace-pre-wrap break-all text-xs text-txt/80">
            {value.slice(0, PARAM_TRUNCATE_LENGTH)}…
          </pre>
          <button
            type="button"
            className="ml-1 text-xs text-blue-400 hover:underline"
            onClick={() => setExpanded(true)}
          >
            {t("workflowGraph.nodeDrawer.showMore")}
          </button>
        </span>
      );
    }
    if (value.length > PARAM_TRUNCATE_LENGTH && expanded) {
      return (
        <span>
          <pre className="inline font-mono whitespace-pre-wrap break-all text-xs text-txt/80">
            {value}
          </pre>
          <button
            type="button"
            className="ml-1 text-xs text-blue-400 hover:underline"
            onClick={() => setExpanded(false)}
          >
            {t("workflowGraph.nodeDrawer.showLess")}
          </button>
        </span>
      );
    }
    return (
      <pre className="font-mono whitespace-pre-wrap break-all text-xs text-txt/80">
        {value}
      </pre>
    );
  }

  if (typeof value === "object" && value !== null) {
    const json = JSON.stringify(value, null, 2);
    if (json.length > PARAM_TRUNCATE_LENGTH && !expanded) {
      return (
        <span>
          <pre className="inline font-mono whitespace-pre-wrap break-all text-xs text-txt/80">
            {json.slice(0, PARAM_TRUNCATE_LENGTH)}…
          </pre>
          <button
            type="button"
            className="ml-1 text-xs text-blue-400 hover:underline"
            onClick={() => setExpanded(true)}
          >
            {t("workflowGraph.nodeDrawer.showMore")}
          </button>
        </span>
      );
    }
    if (json.length > PARAM_TRUNCATE_LENGTH && expanded) {
      return (
        <span>
          <pre className="font-mono whitespace-pre-wrap break-all text-xs text-txt/80">
            {json}
          </pre>
          <button
            type="button"
            className="ml-1 text-xs text-blue-400 hover:underline"
            onClick={() => setExpanded(false)}
          >
            {t("workflowGraph.nodeDrawer.showLess")}
          </button>
        </span>
      );
    }
    return (
      <pre className="font-mono whitespace-pre-wrap break-all text-xs text-txt/80">
        {json}
      </pre>
    );
  }

  return (
    <pre className="font-mono whitespace-pre-wrap break-all text-xs text-txt/80">
      {String(value)}
    </pre>
  );
}

function buildEditorUrl(
  workflow: WorkflowDefinition,
  status: WorkflowStatusResponse,
  cloudAgentId: string | null | undefined,
  uiTheme: "light" | "dark",
): string | null {
  let editorUrl: string | null = null;
  if (status.mode === "local" && status.host) {
    editorUrl = `${status.host}/workflow/${encodeURIComponent(workflow.id)}`;
  }
  if (status.mode === "cloud" && cloudAgentId) {
    const cloudBase =
      getBootConfig().cloudApiBase ?? "https://www.elizacloud.ai";
    editorUrl = `${cloudBase}/agents/${encodeURIComponent(cloudAgentId)}/n8n/workflow/${encodeURIComponent(workflow.id)}`;
  }
  if (!editorUrl) {
    return null;
  }

  const url = new URL(editorUrl);
  url.searchParams.set("theme", uiTheme);
  return url.toString();
}

interface NodeDetailDrawerProps {
  node: WorkflowDefinitionNode | null;
  workflow: WorkflowDefinition | null;
  status: WorkflowStatusResponse | null | undefined;
  onClose: () => void;
  labelId: string;
}

function NodeDetailDrawer({
  node,
  workflow,
  status,
  onClose,
  labelId,
}: NodeDetailDrawerProps) {
  const { t, activeAgentProfile, uiTheme } = useApp();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const isOpen = node !== null;

  // Focus the close button when drawer opens
  useEffect(() => {
    if (isOpen) {
      // Defer so the CSS transition can begin first
      const id = setTimeout(() => closeButtonRef.current?.focus(), 60);
      return () => clearTimeout(id);
    }
  }, [isOpen]);

  // Derive display values from the current node (may be stale during close transition — that's fine)
  const colors = resolveNodeColor(node?.type ?? "");
  const typeLabel = (node?.type ?? "node").split(".").pop() ?? "node";
  const hasParams = node?.parameters && Object.keys(node.parameters).length > 0;

  const editorDisabled =
    !status || status.mode === "disabled" || status.status === "error";

  const editorUrl =
    !editorDisabled && workflow && status && node
      ? buildEditorUrl(
          workflow,
          status,
          activeAgentProfile?.cloudAgentId,
          uiTheme,
        )
      : null;

  // Map color families to StatusBadge variants (success | warning | danger | muted)
  // amber=trigger→warning, slate=flow-control→muted, violet=integration→danger, blue=action→muted
  const badgeVariant: "warning" | "muted" | "danger" =
    colors.badge === "#f59e0b"
      ? "warning"
      : colors.badge === "#8b5cf6"
        ? "danger"
        : "muted";

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={isOpen ? labelId : undefined}
      aria-hidden={!isOpen}
      className={[
        "absolute inset-y-0 right-0 z-30 flex w-72 flex-col",
        "border-l border-border/40 bg-bg shadow-xl backdrop-blur-[2px]",
        "transition-transform duration-200 ease-out",
        isOpen ? "translate-x-0" : "translate-x-full",
      ].join(" ")}
    >
      {/* Header */}
      <div className="flex shrink-0 items-start gap-2 border-b border-border/30 px-4 py-3">
        <div className="flex-1 min-w-0 space-y-1">
          <h2
            id={labelId}
            className="text-sm font-semibold text-txt leading-tight truncate"
          >
            {node?.name ?? ""}
          </h2>
          {/* Type badge */}
          <div className="flex items-center gap-1.5">
            <StatusBadge label={typeLabel} variant={badgeVariant} />
          </div>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label={t("workflowGraph.closeDrawer")}
          tabIndex={isOpen ? 0 : -1}
          className="shrink-0 flex h-6 w-6 items-center justify-center rounded text-muted hover:text-txt transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Scrollable body — only meaningful content when open */}
      <div className="flex-1 overflow-y-auto space-y-4 px-4 py-3">
        {node && (
          <>
            {node.notes?.trim() ? (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Step
                </div>
                <div className="rounded bg-bg/40 border border-border/20 px-2 py-2">
                  <p className="text-xs leading-relaxed text-txt/80">
                    {node.notes.trim()}
                  </p>
                </div>
              </div>
            ) : null}

            {/* Parameters */}
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                {t("common.parameters")}
              </div>
              {hasParams ? (
                <div className="space-y-2">
                  {Object.entries(node.parameters ?? {}).map(([key, val]) => (
                    <div key={key} className="space-y-0.5">
                      <div className="text-xs font-medium text-muted/80 font-mono">
                        {key}
                      </div>
                      <div className="rounded bg-bg/40 border border-border/20 px-2 py-1">
                        <ParamValue value={val} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted/60 italic">
                  {t("workflowGraph.nodeDrawer.noParameters")}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {/* Footer — open in editor */}
      <div className="shrink-0 border-t border-border/30 px-4 py-3">
        {editorUrl ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs gap-1.5"
            tabIndex={isOpen ? 0 : -1}
            onClick={() => window.open(editorUrl, "_blank", "noopener")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t("workflowGraph.nodeDrawer.openInEditor")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs"
            disabled
            tabIndex={isOpen ? 0 : -1}
            title={t("workflowGraph.nodeDrawer.editorDisabled")}
          >
            {t("workflowGraph.nodeDrawer.openInEditor")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Graph panel (shared between inline and full-screen modal) ─────────────────

function GraphPanel({
  nodes,
  edges,
  isGenerating,
  ariaLabel,
  onNodeClick,
  uiTheme,
}: {
  nodes: Node[];
  edges: Edge[];
  isGenerating: boolean;
  ariaLabel: string;
  onNodeClick?: (e: React.MouseEvent, node: Node) => void;
  uiTheme: "light" | "dark";
}) {
  const chrome = graphChrome(uiTheme);

  return (
    <ReactFlow
      nodes={nodes}
      edges={isGenerating ? generatingEdges(edges) : edges}
      nodesDraggable={!isGenerating}
      nodesConnectable={false}
      edgesReconnectable={false}
      onNodeClick={onNodeClick}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
      proOptions={{ hideAttribution: true }}
      aria-label={ariaLabel}
    >
      <Background color={chrome.dots} gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        nodeColor={(n) => {
          const colors = (n.data as { colors?: { border: string } })?.colors;
          return colors?.border ?? "#475569";
        }}
        maskColor={chrome.minimapMask}
        style={{
          background: chrome.minimapBg,
          border: `1px solid ${chrome.minimapBorder}`,
        }}
      />
    </ReactFlow>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface WorkflowGraphViewerProps {
  workflow: WorkflowDefinition | null;
  loading?: boolean;
  isGenerating?: boolean;
  emptyStateActionLabel?: string;
  emptyStateHelpText?: string;
  onNodeClick?: (nodeName: string) => void;
  onEmptyStateAction?: () => void;
  /** n8n status — drives the "Open in editor" button URL and enabled state. */
  status?: WorkflowStatusResponse | null;
}

export function WorkflowGraphViewer({
  workflow,
  loading = false,
  isGenerating = false,
  emptyStateActionLabel = "Describe your workflow",
  emptyStateHelpText = "Describe the trigger and steps in the sidebar.",
  onNodeClick,
  onEmptyStateAction,
  status,
}: WorkflowGraphViewerProps) {
  const { activeAgentProfile, uiTheme } = useApp();
  const [fullScreen, setFullScreen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<WorkflowDefinitionNode | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const drawerLabelId = useId();

  const { nodes, edges } = useMemo(
    () => workflowToReactFlow(workflow),
    [workflow],
  );

  const ariaLabel = `Workflow graph with ${nodes.length} nodes and ${edges.length} connections`;

  // Clear selected node when workflow changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset drawer on workflow identity change
  useEffect(() => {
    setSelectedNode(null);
  }, [workflow?.id]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const label = (node.data as { label?: string })?.label ?? node.id;
      const found =
        workflow?.nodes?.find((n) => n.id === node.id || n.name === label) ??
        null;
      setSelectedNode(found);
      onNodeClick?.(label);
    },
    [onNodeClick, workflow],
  );

  const handleCloseDrawer = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Escape key closes drawer (only active when drawer is open and full-screen is closed)
  useEffect(() => {
    if (!selectedNode || fullScreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedNode(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNode, fullScreen]);

  // Trap focus in full-screen modal with Escape to close (when drawer not open)
  useEffect(() => {
    if (!fullScreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedNode) {
          setSelectedNode(null);
        } else {
          setFullScreen(false);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fullScreen, selectedNode]);

  const hasNodes = nodes.length > 0;
  const editorDisabled =
    !status || status.mode === "disabled" || status.status === "error";
  const editorUrl =
    !editorDisabled && workflow && status
      ? buildEditorUrl(
          workflow,
          status,
          activeAgentProfile?.cloudAgentId,
          uiTheme,
        )
      : null;

  const borderClass = isGenerating
    ? "animate-pulse ring-2 ring-blue-500/50"
    : "ring-1 ring-border/30";
  const chrome = graphChrome(uiTheme);

  return (
    <>
      {/* ── Embedded viewer ─────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        role="img"
        aria-label={ariaLabel}
        className={`relative overflow-hidden rounded-lg ${borderClass}`}
        style={{ height: 420, background: chrome.canvasBg }}
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
            <p className={`text-sm font-medium ${chrome.emptyTitleClass}`}>
              Blank workflow
            </p>
            <p className={`max-w-sm text-xs ${chrome.emptyHelpClass}`}>
              {emptyStateHelpText}
            </p>
            {onEmptyStateAction && (
              <button
                type="button"
                className="mt-1 rounded-md border border-border/40 bg-bg/40 px-3 py-1.5 text-xs text-txt hover:bg-bg/70 transition-colors"
                onClick={onEmptyStateAction}
              >
                {emptyStateActionLabel}
              </button>
            )}
          </div>
        )}

        {/* Generating overlay on top of graph */}
        {isGenerating && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center backdrop-blur-[1px]"
            style={{ background: chrome.overlayBg }}
          >
            <WorkflowGenerationProgress chrome={chrome} />
          </div>
        )}

        {/* The graph (render even with 0 nodes so React Flow mounts cleanly) */}
        {!loading && (
          // biome-ignore lint/a11y/noStaticElementInteractions: React Flow owns interactions inside this container.
          <div
            role="presentation"
            className="h-full w-full"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
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
              <Background color={chrome.dots} gap={20} size={1} />
              <Controls showInteractive={false} />
              {hasNodes && (
                <MiniMap
                  nodeColor={(n) => {
                    const colors = (n.data as { colors?: { border: string } })
                      ?.colors;
                    return colors?.border ?? "#475569";
                  }}
                  maskColor={chrome.minimapMask}
                  style={{
                    background: chrome.minimapBg,
                    border: `1px solid ${chrome.minimapBorder}`,
                  }}
                />
              )}
            </ReactFlow>
          </div>
        )}

        {/* Full-screen toggle button — shift left when drawer is open */}
        {hasNodes && !isGenerating && (
          <button
            type="button"
            aria-label="Full screen"
            className={[
              "absolute top-3 z-20 flex h-7 w-7 items-center justify-center",
              "rounded border border-border/40 bg-bg/80 text-muted hover:text-txt transition-all duration-200",
              selectedNode ? "right-[calc(18rem_+_0.75rem)]" : "right-3",
            ].join(" ")}
            onClick={() => setFullScreen(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}

        {editorUrl && !isGenerating && (
          <button
            type="button"
            aria-label="Open in n8n editor"
            className="absolute right-12 top-3 z-20 rounded border border-border/40 bg-bg/80 px-2.5 py-1 text-xs text-muted transition-colors hover:text-txt"
            onClick={() => window.open(editorUrl, "_blank", "noopener")}
          >
            Open in n8n
          </button>
        )}

        {/* Node detail drawer — embedded mode */}
        {!fullScreen && (
          <NodeDetailDrawer
            node={selectedNode}
            workflow={workflow}
            status={status}
            onClose={handleCloseDrawer}
            labelId={drawerLabelId}
          />
        )}
      </div>

      {/* ── Full-screen dialog ───────────────────────────────────────────── */}
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
          {/* Graph + drawer share a relative container so the drawer overlays the graph */}
          <div
            className="relative flex-1 min-h-0 overflow-hidden"
            style={{ background: chrome.canvasBg }}
          >
            <GraphPanel
              nodes={nodes}
              edges={edges}
              isGenerating={isGenerating}
              ariaLabel={ariaLabel}
              onNodeClick={handleNodeClick}
              uiTheme={uiTheme}
            />
            {/* Node detail drawer — full-screen mode (mounts inside the Dialog portal) */}
            <NodeDetailDrawer
              node={selectedNode}
              workflow={workflow}
              status={status}
              onClose={handleCloseDrawer}
              labelId={drawerLabelId}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
