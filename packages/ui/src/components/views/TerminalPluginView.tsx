interface TerminalPluginViewProps {
  id: string;
  label: string;
  description?: string;
  commands?: string[];
  endpoints?: string[];
}

export function TerminalPluginView({
  id,
  label,
  description,
  commands = [],
  endpoints = [],
}: TerminalPluginViewProps) {
  const state = {
    viewType: "tui",
    viewId: id,
    label,
    commandCount: commands.length,
    endpointCount: endpoints.length,
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
        {(commands.length
          ? commands
          : ["get-state", "get-text", "refresh"]
        ).map((command) => (
          <div key={command} style={{ padding: "4px 0" }}>
            <span style={{ color: "#475569" }}>$</span> {command}
          </div>
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
      </div>
    </div>
  );
}
