import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";

interface D {
  label: string;
  phase: string;
  phaseColor: string;
  description: string;
  status: string;
  durationMs: number;
  llmCallCount: number;
  hasError: boolean;
  isCompleted: boolean;
  isHighlighted?: boolean;
}

export const DagNode = memo(function DagNode({ data }: NodeProps) {
  const d = data as unknown as D;
  const done = d.isCompleted;
  const skip = d.status === "skipped" || d.status === "pending";
  const err = d.status === "error";
  const hl = d.isHighlighted;

  const border = hl
    ? "#ec4899"
    : err
      ? "#ef4444"
      : done
        ? d.phaseColor
        : "#334155";

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: hl ? "#ec4899" : "#475569",
          width: 5,
          height: 5,
        }}
      />
      <div
        style={{
          background: hl ? "#1e1030" : "#1e293b",
          border: `2px solid ${border}`,
          borderRadius: 7,
          padding: "6px 10px",
          width: 190,
          opacity: skip ? 0.4 : 1,
          cursor: "pointer",
          transition: "all .25s",
          ...(hl
            ? { boxShadow: "0 0 14px rgba(236,72,153,.4)" }
            : done && !err
              ? { boxShadow: `0 0 8px ${d.phaseColor}44` }
              : {}),
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: hl
                ? "#ec4899"
                : err
                  ? "#ef4444"
                  : done
                    ? d.phaseColor
                    : "#94a3b8",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {err ? "\u2717" : done ? "\u2713" : "\u25CB"} {d.label}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            marginTop: 3,
            fontSize: 9.5,
            color: "#94a3b8",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              background: hl ? "#ec489922" : `${d.phaseColor}22`,
              color: hl ? "#ec4899" : d.phaseColor,
              padding: "0 4px",
              borderRadius: 3,
            }}
          >
            {d.phase}
          </span>
          {d.durationMs > 0 && <span>{d.durationMs}ms</span>}
          {d.llmCallCount > 0 && (
            <span
              style={{
                background: "#7c3aed22",
                color: "#a78bfa",
                padding: "0 4px",
                borderRadius: 3,
              }}
            >
              LLM x{d.llmCallCount}
            </span>
          )}
          {hl && (
            <span
              style={{
                background: "#ec489922",
                color: "#f9a8d4",
                padding: "0 4px",
                borderRadius: 3,
                fontWeight: 600,
              }}
            >
              NPC
            </span>
          )}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: hl ? "#ec4899" : "#475569",
          width: 5,
          height: 5,
        }}
      />
    </>
  );
});
