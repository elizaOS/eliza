import { useState } from "react";
import { fetchWithCsrf } from "../../api/csrf-client";

interface TerminalPluginViewProps {
  id: string;
  label: string;
  description?: string;
  commands?: string[];
  endpoints?: string[];
}

const commandButtonStyle = {
  display: "block",
  width: "100%",
  border: 0,
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  padding: "4px 6px",
  textAlign: "left" as const,
};

export function TerminalPluginView({
  id,
  label,
  description,
  commands = [],
  endpoints = [],
}: TerminalPluginViewProps) {
  const resolvedCommands = commands.length
    ? commands
    : ["get-state", "get-text", "refresh"];
  const [transcript, setTranscript] = useState<
    Array<{ id: number; command: string; status: string; output: string }>
  >([]);
  const state = {
    viewType: "tui",
    viewId: id,
    label,
    commandCount: resolvedCommands.length,
    endpointCount: endpoints.length,
  };
  const runCommand = async (command: string) => {
    const lineId = Date.now();
    setTranscript((lines) => [
      ...lines,
      { id: lineId, command, status: "pending", output: "running..." },
    ]);

    window.dispatchEvent(
      new CustomEvent("eliza:tui-command", {
        detail: { viewId: id, command },
      }),
    );

    try {
      const response = await fetchWithCsrf(
        `/api/views/${encodeURIComponent(id)}/interact?viewType=tui`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capability: command, timeoutMs: 5_000 }),
        },
      );
      const text = await response.text();
      let parsed: unknown = text;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!response.ok) {
        throw new Error(
          typeof parsed === "object" && parsed !== null && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : response.statusText,
        );
      }
      setTranscript((lines) =>
        lines.map((line) =>
          line.id === lineId
            ? {
                ...line,
                status: "ok",
                output: JSON.stringify(parsed, null, 2),
              }
            : line,
        ),
      );
    } catch (error) {
      setTranscript((lines) =>
        lines.map((line) =>
          line.id === lineId
            ? {
                ...line,
                status: "error",
                output: error instanceof Error ? error.message : String(error),
              }
            : line,
        ),
      );
    }
  };

  return (
    <div
      data-view-state={JSON.stringify(state)}
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "#7dd3fc", marginBottom: 4 }}>
        elizaos://{id} --type=tui
      </div>
      <div style={{ color: "#e2e8f0", fontWeight: 700, marginBottom: 8 }}>
        {label}
      </div>
      {description && (
        <div style={{ color: "#94a3b8", marginBottom: 18 }}>{description}</div>
      )}
      <div
        style={{
          border: "1px solid rgba(125,211,252,0.3)",
          borderRadius: 6,
          padding: 16,
        }}
      >
        <div style={{ color: "#a7f3d0", marginBottom: 10 }}>capabilities</div>
        {resolvedCommands.map((command, index) => (
          <button
            key={command}
            type="button"
            data-terminal-command={command}
            aria-label={`Run ${command}`}
            title={`Run ${command} (${index + 1})`}
            style={commandButtonStyle}
            onClick={() => {
              void runCommand(command);
            }}
          >
            <span style={{ color: "#475569" }}>$</span> {command}
            <span style={{ color: "#64748b", float: "right" }}>
              {index + 1}
            </span>
          </button>
        ))}
        {endpoints.length > 0 && (
          <>
            <div style={{ color: "#a7f3d0", margin: "18px 0 10px" }}>
              endpoints
            </div>
            {endpoints.map((endpoint) => (
              <div key={endpoint} style={{ padding: "4px 0" }}>
                <span style={{ color: "#475569" }}>GET</span> {endpoint}
              </div>
            ))}
          </>
        )}
        {transcript.length > 0 && (
          <>
            <div style={{ color: "#a7f3d0", margin: "18px 0 10px" }}>
              output
            </div>
            {transcript.map((line) => (
              <pre
                key={line.id}
                data-terminal-output={line.status}
                style={{
                  margin: "8px 0 0",
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  color: line.status === "error" ? "#fca5a5" : "#cbd5e1",
                }}
              >
                $ {line.command}
                {"\n"}[{line.status}] {line.output}
              </pre>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
