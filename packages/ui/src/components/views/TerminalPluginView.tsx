import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Network,
  Play,
  SquareTerminal,
} from "lucide-react";
import { type CSSProperties, useState } from "react";
import { fetchWithCsrf } from "../../api/csrf-client";
import { Button } from "../ui/button";

interface TerminalPluginViewProps {
  id: string;
  label: string;
  description?: string;
  commands?: string[];
  endpoints?: string[];
}

const shellStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#08111f",
  color: "#d6e4ef",
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  padding: 20,
};

const panelStyle: CSSProperties = {
  border: "1px solid rgba(148,163,184,0.22)",
  borderRadius: 8,
  background: "#0d1828",
  overflow: "hidden",
};

const commandButtonStyle: CSSProperties = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  gap: 10,
  border: "1px solid rgba(148,163,184,0.16)",
  borderRadius: 6,
  background: "#101d2d",
  color: "#d6e4ef",
  cursor: "pointer",
  font: "inherit",
  minHeight: 38,
  padding: "0 10px",
  textAlign: "left" as const,
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid rgba(148,163,184,0.2)",
  borderRadius: 999,
  color: "#b6c9d8",
  background: "#101d2d",
  padding: "5px 9px",
  fontSize: 12,
  lineHeight: 1,
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "#8bd3ff",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0,
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
      title={description}
      style={shellStyle}
    >
      <div style={panelStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            borderBottom: "1px solid rgba(148,163,184,0.18)",
            padding: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                display: "grid",
                placeItems: "center",
                width: 38,
                height: 38,
                borderRadius: 8,
                background: "#142238",
                color: "#8bd3ff",
              }}
            >
              <SquareTerminal size={20} aria-hidden="true" />
            </div>
            <div>
              <div style={{ color: "#eef6ff", fontWeight: 700 }}>{label}</div>
              <div style={{ color: "#7890a4", fontSize: 12 }}>
                elizaos://{id} --type=tui
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <span style={chipStyle}>
              <Activity size={13} aria-hidden="true" />
              {resolvedCommands.length}
            </span>
            <span style={chipStyle}>
              <Network size={13} aria-hidden="true" />
              {endpoints.length}
            </span>
          </div>
        </div>

        <div style={{ padding: 14 }}>
          <div style={{ ...sectionHeaderStyle, marginBottom: 10 }}>
            <Activity size={14} aria-hidden="true" />
            capabilities
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 8,
            }}
          >
            {resolvedCommands.map((command, index) => (
              <Button
                key={command}
                variant="ghost"
                data-terminal-command={command}
                aria-label={`Run ${command}`}
                title={`Run ${command} (${index + 1})`}
                className="h-auto whitespace-normal rounded-none p-0 text-left font-normal hover:bg-transparent"
                style={commandButtonStyle}
                onClick={() => {
                  void runCommand(command);
                }}
              >
                <Play
                  size={14}
                  aria-hidden="true"
                  style={{ color: "#8bd3ff" }}
                />
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  {command}
                </span>
                <span style={{ color: "#7890a4", marginLeft: "auto" }}>
                  {index + 1}
                </span>
              </Button>
            ))}
          </div>
          {endpoints.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ ...sectionHeaderStyle, marginBottom: 10 }}>
                <Network size={14} aria-hidden="true" />
                endpoints
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {endpoints.map((endpoint) => (
                  <span key={endpoint} style={chipStyle}>
                    <span style={{ color: "#8bd3ff" }}>GET</span>
                    {endpoint}
                  </span>
                ))}
              </div>
            </div>
          )}
          {transcript.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ ...sectionHeaderStyle, marginBottom: 10 }}>
                <SquareTerminal size={14} aria-hidden="true" />
                output
              </div>
              {transcript.map((line) => (
                <pre
                  key={line.id}
                  data-terminal-output={line.status}
                  style={{
                    margin: "8px 0 0",
                    border: "1px solid rgba(148,163,184,0.16)",
                    borderRadius: 6,
                    background: "#07101d",
                    padding: 10,
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                    color: line.status === "error" ? "#ffb4a8" : "#d6e4ef",
                  }}
                >
                  {line.status === "error" ? (
                    <CircleAlert size={14} aria-hidden="true" />
                  ) : (
                    <CheckCircle2 size={14} aria-hidden="true" />
                  )}{" "}
                  $ {line.command}
                  {"\n"}[{line.status}] {line.output}
                </pre>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
