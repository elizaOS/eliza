"use client";

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

interface NodeData {
  nodeId: string;
  name: string;
  phase: string;
  durationMs: number;
  status: "success" | "error" | "skipped";
}

interface TickTimelineProps {
  nodes: NodeData[];
  onNodeClick: (nodeId: string) => void;
}

export function TickTimeline({ nodes, onNodeClick }: TickTimelineProps) {
  const maxDuration = Math.max(...nodes.map((n) => n.durationMs), 1);

  return (
    <div
      style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40 }}
    >
      {nodes
        .filter((n) => n.status !== "skipped")
        .map((node) => {
          const height = Math.max(4, (node.durationMs / maxDuration) * 36);
          const color = PHASE_COLORS[node.phase] ?? "#6b7280";

          return (
            <button
              key={node.nodeId}
              onClick={() => onNodeClick(node.nodeId)}
              title={`${node.name}: ${node.durationMs}ms`}
              style={{
                width: 16,
                height,
                background: node.status === "error" ? "#ef4444" : color,
                borderRadius: "2px 2px 0 0",
                border: "none",
                cursor: "pointer",
                opacity: 0.8,
                transition: "opacity 0.15s",
                padding: 0,
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.opacity = "0.8";
              }}
            />
          );
        })}
    </div>
  );
}
