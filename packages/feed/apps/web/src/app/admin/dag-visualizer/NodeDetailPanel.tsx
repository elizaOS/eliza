"use client";

import { useState } from "react";

interface NodeData {
  nodeId: string;
  name: string;
  phase: string;
  phaseNumber: number;
  durationMs: number;
  status: "success" | "error" | "skipped";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error?: string;
  llmCallIds: string[];
}

interface NodeDetailPanelProps {
  node: NodeData;
  llmCalls: Array<Record<string, unknown>>;
  npcTrajectories: Array<Record<string, unknown>>;
  onClose: () => void;
}

type TabId = "overview" | "inputs" | "outputs" | "llm" | "npc";

export function NodeDetailPanel({
  node,
  llmCalls,
  npcTrajectories,
  onClose,
}: NodeDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [expandedCall, setExpandedCall] = useState<string | null>(null);

  const tabs: Array<{ id: TabId; label: string; count?: number }> = [
    { id: "overview", label: "Overview" },
    { id: "inputs", label: "Inputs" },
    { id: "outputs", label: "Outputs" },
    { id: "llm", label: "LLM Calls", count: llmCalls.length },
    { id: "npc", label: "NPC Data", count: npcTrajectories.length },
  ];

  return (
    <div
      style={{
        width: 480,
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
          padding: "12px 16px",
          borderBottom: "1px solid #1e293b",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ color: "#f1f5f9", fontSize: 16, fontWeight: 600 }}>
            {node.name}
          </div>
          <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>
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
            fontSize: 20,
            padding: 4,
          }}
        >
          &#x2715;
        </button>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid #1e293b",
          padding: "0 16px",
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: "none",
              border: "none",
              borderBottom:
                activeTab === tab.id
                  ? "2px solid #3b82f6"
                  : "2px solid transparent",
              color: activeTab === tab.id ? "#e2e8f0" : "#64748b",
              padding: "8px 12px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span
                style={{
                  marginLeft: 4,
                  background: "#1e293b",
                  padding: "1px 5px",
                  borderRadius: 8,
                  fontSize: 10,
                }}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {activeTab === "overview" && (
          <div style={{ color: "#cbd5e1", fontSize: 13 }}>
            {node.error && (
              <div
                style={{
                  background: "#7f1d1d22",
                  border: "1px solid #7f1d1d",
                  borderRadius: 6,
                  padding: 12,
                  marginBottom: 12,
                  color: "#fca5a5",
                }}
              >
                <strong>Error:</strong> {node.error}
              </div>
            )}
            <InfoRow label="Node ID" value={node.nodeId} />
            <InfoRow
              label="Phase"
              value={`${node.phase} (${node.phaseNumber})`}
            />
            <InfoRow label="Duration" value={`${node.durationMs}ms`} />
            <InfoRow label="Status" value={node.status} />
            <InfoRow label="LLM Calls" value={String(node.llmCallIds.length)} />
            <InfoRow
              label="Input Keys"
              value={Object.keys(node.inputs).join(", ") || "none"}
            />
            <InfoRow
              label="Output Keys"
              value={Object.keys(node.outputs).join(", ") || "none"}
            />
          </div>
        )}

        {activeTab === "inputs" && (
          <JsonBlock data={node.inputs} label="Inputs" />
        )}

        {activeTab === "outputs" && (
          <JsonBlock data={node.outputs} label="Outputs" />
        )}

        {activeTab === "llm" && (
          <div>
            {llmCalls.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: 13 }}>
                No LLM calls for this node
              </div>
            ) : (
              llmCalls.map((call) => (
                <LLMCallCard
                  key={call.callId as string}
                  call={call}
                  expanded={expandedCall === (call.callId as string)}
                  onToggle={() =>
                    setExpandedCall(
                      expandedCall === (call.callId as string)
                        ? null
                        : (call.callId as string),
                    )
                  }
                />
              ))
            )}
          </div>
        )}

        {activeTab === "npc" && (
          <div>
            {npcTrajectories.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: 13 }}>
                No NPC trajectory data for this tick
              </div>
            ) : (
              npcTrajectories.map((npc, i) => <NpcCard key={i} npc={npc} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "4px 0",
        borderBottom: "1px solid #1e293b",
      }}
    >
      <span style={{ color: "#64748b" }}>{label}</span>
      <span style={{ color: "#e2e8f0" }}>{value}</span>
    </div>
  );
}

function JsonBlock({ data, label }: { data: unknown; label: string }) {
  return (
    <div>
      <div
        style={{
          color: "#94a3b8",
          fontSize: 11,
          marginBottom: 4,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <pre
        style={{
          background: "#1e293b",
          borderRadius: 6,
          padding: 12,
          color: "#e2e8f0",
          fontSize: 11,
          fontFamily: "monospace",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 600,
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

function LLMCallCard({
  call,
  expanded,
  onToggle,
}: {
  call: Record<string, unknown>;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        background: "#1e293b",
        borderRadius: 6,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <button
        onClick={onToggle}
        style={{
          background: "none",
          border: "none",
          width: "100%",
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          color: "#e2e8f0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            {call.promptType as string}
          </span>
          <span
            style={{
              fontSize: 10,
              color: "#94a3b8",
              background: "#0f172a",
              padding: "1px 6px",
              borderRadius: 4,
            }}
          >
            {call.provider as string}/{call.model as string}
          </span>
        </div>
        <div
          style={{ fontSize: 11, color: "#94a3b8", display: "flex", gap: 8 }}
        >
          <span>{call.durationMs as number}ms</span>
          <span>
            {((call.totalTokens as number) ?? 0).toLocaleString()} tok
          </span>
          <span>{expanded ? "\u25B2" : "\u25BC"}</span>
        </div>
      </button>

      {expanded && (
        <div style={{ padding: "0 12px 12px", fontSize: 11 }}>
          <PromptSection
            title="System Prompt"
            content={call.systemPrompt as string}
          />
          <PromptSection
            title="User Prompt"
            content={call.userPrompt as string}
          />
          <PromptSection
            title="Raw Response"
            content={call.rawResponse as string}
          />
          {call.parsedResponse != null && (
            <div style={{ marginTop: 8 }}>
              <div
                style={{ color: "#94a3b8", fontWeight: 600, marginBottom: 4 }}
              >
                Parsed Response
              </div>
              <pre
                style={{
                  background: "#0f172a",
                  padding: 8,
                  borderRadius: 4,
                  color: "#a5b4fc",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 300,
                  overflow: "auto",
                  fontFamily: "monospace",
                }}
              >
                {JSON.stringify(call.parsedResponse, null, 2)}
              </pre>
            </div>
          )}
          <div
            style={{ marginTop: 8, display: "flex", gap: 12, color: "#64748b" }}
          >
            <span>In: {(call.inputTokens as number).toLocaleString()}</span>
            <span>Out: {(call.outputTokens as number).toLocaleString()}</span>
            <span>Temp: {call.temperature as number}</span>
            <span>Max: {(call.maxTokens as number).toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PromptSection({
  title,
  content,
}: {
  title: string;
  content?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!content) return null;

  const preview =
    content.length > 300 ? `${content.slice(0, 300)}...` : content;

  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: "none",
          border: "none",
          color: "#94a3b8",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 11,
          padding: 0,
        }}
      >
        {expanded ? "\u25BC" : "\u25B6"} {title} (
        {content.length.toLocaleString()} chars)
      </button>
      <pre
        style={{
          background: "#0f172a",
          padding: 8,
          borderRadius: 4,
          color: "#cbd5e1",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: expanded ? 500 : 80,
          overflow: expanded ? "auto" : "hidden",
          fontFamily: "monospace",
          marginTop: 4,
        }}
      >
        {expanded ? content : preview}
      </pre>
    </div>
  );
}

function NpcCard({ npc }: { npc: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const decisions = (npc.decisions as Array<unknown>) ?? [];
  const trades = (npc.trades as Array<unknown>) ?? [];
  const posts = (npc.posts as Array<unknown>) ?? [];
  const messages = (npc.groupMessages as Array<unknown>) ?? [];

  return (
    <div
      style={{
        background: "#1e293b",
        borderRadius: 6,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: "none",
          border: "none",
          width: "100%",
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          color: "#e2e8f0",
          fontSize: 12,
        }}
      >
        <span style={{ fontWeight: 600 }}>{npc.npcName as string}</span>
        <span style={{ color: "#94a3b8", fontSize: 11 }}>
          {decisions.length}d / {trades.length}t / {posts.length}p /{" "}
          {messages.length}m
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 12px 12px" }}>
          <JsonBlock data={npc} label="Full NPC Trajectory" />
        </div>
      )}
    </div>
  );
}
