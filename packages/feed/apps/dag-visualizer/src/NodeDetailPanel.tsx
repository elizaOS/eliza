import { useState } from "react";
import type { LLMCallFull, NPCTrajectory, TraceNodeData } from "./types";

interface Props {
  node: TraceNodeData;
  llmCalls: LLMCallFull[];
  npcs: NPCTrajectory[];
  onClose: () => void;
}

type Tab = "overview" | "inputs" | "outputs" | "llm" | "npc";

export function NodeDetailPanel({ node, llmCalls, npcs, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [expandedCall, setExpandedCall] = useState<string | null>(null);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "inputs", label: "Inputs" },
    { id: "outputs", label: "Outputs" },
    { id: "llm", label: "LLM", badge: llmCalls.length },
    { id: "npc", label: "NPCs", badge: npcs.length },
  ];

  return (
    <div
      style={{
        width: 440,
        background: "#0f172a",
        borderLeft: "1px solid #1e293b",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid #1e293b",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ color: "#f1f5f9", fontSize: 15, fontWeight: 600 }}>
            {node.name}
          </div>
          <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>
            {node.nodeId} | {node.phase} | {node.durationMs}ms |{" "}
            <span
              style={{
                color:
                  node.status === "error"
                    ? "#ef4444"
                    : node.status === "skipped"
                      ? "#64748b"
                      : "#22c55e",
              }}
            >
              {node.status}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#64748b",
            cursor: "pointer",
            fontSize: 18,
          }}
        >
          &times;
        </button>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid #1e293b",
          padding: "0 14px",
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 500,
              padding: "6px 10px",
              borderBottom:
                tab === t.id ? "2px solid #3b82f6" : "2px solid transparent",
              color: tab === t.id ? "#e2e8f0" : "#64748b",
            }}
          >
            {t.label}
            {t.badge ? (
              <span
                style={{
                  marginLeft: 3,
                  background: "#1e293b",
                  padding: "0 4px",
                  borderRadius: 6,
                  fontSize: 9,
                }}
              >
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 14, fontSize: 12 }}>
        {tab === "overview" && (
          <div style={{ color: "#cbd5e1" }}>
            {node.error && (
              <div
                style={{
                  background: "#7f1d1d22",
                  border: "1px solid #7f1d1d",
                  borderRadius: 5,
                  padding: 10,
                  marginBottom: 10,
                  color: "#fca5a5",
                }}
              >
                <b>Error:</b> {node.error}
              </div>
            )}
            <Row label="Node ID" value={node.nodeId} />
            <Row label="Phase" value={`${node.phase} (${node.phaseNumber})`} />
            <Row label="Duration" value={`${node.durationMs}ms`} />
            <Row label="Status" value={node.status} />
            <Row label="LLM Calls" value={String(node.llmCallIds.length)} />
          </div>
        )}
        {tab === "inputs" && <Json data={node.inputs} />}
        {tab === "outputs" && <Json data={node.outputs} />}
        {tab === "llm" &&
          (llmCalls.length === 0 ? (
            <div style={{ color: "#64748b" }}>No LLM calls</div>
          ) : (
            llmCalls.map((c) => (
              <LLMCard
                key={c.callId}
                call={c}
                expanded={expandedCall === c.callId}
                toggle={() =>
                  setExpandedCall(expandedCall === c.callId ? null : c.callId)
                }
              />
            ))
          ))}
        {tab === "npc" &&
          (npcs.length === 0 ? (
            <div style={{ color: "#64748b" }}>No NPC data</div>
          ) : (
            npcs.map((n, i) => <NPCCard key={i} npc={n} />)
          ))}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "3px 0",
        borderBottom: "1px solid #1e293b",
      }}
    >
      <span style={{ color: "#64748b" }}>{label}</span>
      <span style={{ color: "#e2e8f0" }}>{value}</span>
    </div>
  );
}

function Json({ data }: { data: unknown }) {
  return (
    <pre
      style={{
        background: "#1e293b",
        borderRadius: 5,
        padding: 10,
        color: "#e2e8f0",
        fontSize: 10.5,
        fontFamily: "monospace",
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 600,
      }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function LLMCard({
  call,
  expanded,
  toggle,
}: {
  call: LLMCallFull;
  expanded: boolean;
  toggle: () => void;
}) {
  return (
    <div
      style={{
        background: "#1e293b",
        borderRadius: 5,
        marginBottom: 6,
        overflow: "hidden",
      }}
    >
      <button
        onClick={toggle}
        style={{
          background: "none",
          border: "none",
          width: "100%",
          padding: "8px 10px",
          display: "flex",
          justifyContent: "space-between",
          cursor: "pointer",
          color: "#e2e8f0",
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600 }}>{call.promptType}</span>
        <span style={{ fontSize: 10, color: "#94a3b8" }}>
          {call.durationMs}ms | {call.totalTokens?.toLocaleString()} tok
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 10px 10px", fontSize: 10.5 }}>
          <PromptBlock
            title={`System (${call.systemPrompt?.length ?? 0} chars)`}
            text={call.systemPrompt}
          />
          <PromptBlock
            title={`User (${call.userPrompt?.length ?? 0} chars)`}
            text={call.userPrompt}
          />
          <PromptBlock
            title={`Response (${call.rawResponse?.length ?? 0} chars)`}
            text={call.rawResponse}
          />
          {call.parsedResponse != null && (
            <>
              <div style={{ color: "#94a3b8", fontWeight: 600, marginTop: 6 }}>
                Parsed
              </div>
              <Json data={call.parsedResponse} />
            </>
          )}
          <div
            style={{ marginTop: 6, color: "#64748b", display: "flex", gap: 10 }}
          >
            <span>
              {call.provider}/{call.model}
            </span>
            <span>In:{call.inputTokens?.toLocaleString()}</span>
            <span>Out:{call.outputTokens?.toLocaleString()}</span>
            <span>T={call.temperature}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PromptBlock({ title, text }: { title: string; text?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "none",
          border: "none",
          color: "#94a3b8",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 10.5,
          padding: 0,
        }}
      >
        {open ? "\u25BC" : "\u25B6"} {title}
      </button>
      <pre
        style={{
          background: "#0f172a",
          padding: 6,
          borderRadius: 3,
          color: "#cbd5e1",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: open ? 400 : 60,
          overflow: open ? "auto" : "hidden",
          fontFamily: "monospace",
          marginTop: 3,
          fontSize: 10,
        }}
      >
        {open ? text : text.slice(0, 200) + (text.length > 200 ? "..." : "")}
      </pre>
    </div>
  );
}

function NPCCard({ npc }: { npc: NPCTrajectory }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: "#1e293b", borderRadius: 5, marginBottom: 6 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "none",
          border: "none",
          width: "100%",
          padding: "8px 10px",
          display: "flex",
          justifyContent: "space-between",
          cursor: "pointer",
          color: "#e2e8f0",
          fontSize: 11,
        }}
      >
        <span style={{ fontWeight: 600 }}>{npc.npcName}</span>
        <span style={{ color: "#94a3b8", fontSize: 10 }}>
          {npc.decisions?.length ?? 0}d / {npc.trades?.length ?? 0}t
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 10px 10px" }}>
          <Json data={npc} />
        </div>
      )}
    </div>
  );
}
