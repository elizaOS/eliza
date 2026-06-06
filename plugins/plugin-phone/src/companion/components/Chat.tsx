import { Link2, MonitorUp, QrCode, Radio } from "lucide-react";
import type React from "react";
import { useEffect } from "react";
import { agentUrl as configuredAgentUrl, logger } from "../services";

interface ChatProps {
  pairedAgentUrl: string | null;
  onOpenPairing(): void;
  onOpenRemoteSession(): void;
  remoteSessionAvailable: boolean;
}

/**
 * Overlay-chat-friendly companion home. Chat streaming lives in the host chat;
 * this view only exposes pairing and remote-session state.
 */
export function Chat({
  pairedAgentUrl,
  onOpenPairing,
  onOpenRemoteSession,
  remoteSessionAvailable,
}: ChatProps): React.JSX.Element {
  const resolvedAgentUrl = pairedAgentUrl ?? configuredAgentUrl();
  const paired = resolvedAgentUrl !== null;

  useEffect(() => {
    logger.info("[Chat] mount", {
      resolvedAgentUrl,
      remoteSessionAvailable,
    });
  }, [resolvedAgentUrl, remoteSessionAvailable]);

  return (
    <main style={styles.root}>
      <header style={styles.header}>
        <h2 style={styles.title}>Companion</h2>
        <div style={styles.statusGrid}>
          <StatusTile
            icon={<Radio size={18} />}
            active={paired}
            value={paired ? "Paired" : "Offline"}
          />
          <StatusTile
            icon={<MonitorUp size={18} />}
            active={remoteSessionAvailable}
            value={remoteSessionAvailable ? "Live" : "Idle"}
          />
        </div>
      </header>

      <section style={styles.body}>
        <div style={styles.agentCard}>
          <Link2 size={18} color={paired ? "#22c55e" : "#6b7280"} />
          <span style={styles.url}>{resolvedAgentUrl ?? "No agent"}</span>
        </div>

        <div style={styles.actions}>
          <button
            type="button"
            onClick={onOpenPairing}
            style={paired ? styles.secondaryAction : styles.primaryAction}
          >
            <QrCode size={18} />
            <span>{paired ? "Re-pair" : "Pair"}</span>
          </button>

          <button
            type="button"
            onClick={onOpenRemoteSession}
            disabled={!remoteSessionAvailable}
            style={
              remoteSessionAvailable
                ? styles.primaryAction
                : styles.disabledAction
            }
          >
            <MonitorUp size={18} />
            <span>Remote</span>
          </button>
        </div>
      </section>
    </main>
  );
}

function StatusTile({
  icon,
  active,
  value,
}: {
  icon: React.ReactNode;
  active: boolean;
  value: string;
}) {
  return (
    <div style={styles.statusTile}>
      <span style={active ? styles.statusIconActive : styles.statusIcon}>
        {icon}
      </span>
      <span style={styles.statusValue}>{value}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#0b0f14",
    color: "#f8fafc",
  },
  header: {
    padding: 20,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    borderBottom: "1px solid #1f2937",
  },
  title: { margin: 0, fontSize: 20, fontWeight: 650 },
  statusGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  statusTile: {
    minHeight: 68,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    border: "1px solid #1f2937",
    borderRadius: 8,
    background: "#111827",
  },
  statusIcon: { display: "flex", color: "#6b7280" },
  statusIconActive: { display: "flex", color: "#22c55e" },
  statusValue: { fontSize: 14, fontWeight: 650 },
  body: {
    flex: 1,
    padding: 20,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  agentCard: {
    minHeight: 56,
    display: "flex",
    alignItems: "center",
    gap: 10,
    border: "1px solid #1f2937",
    borderRadius: 8,
    background: "#111827",
    padding: "0 14px",
  },
  actions: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  primaryAction: {
    minHeight: 52,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    background: "#f97316",
    color: "#111827",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 700,
  },
  secondaryAction: {
    minHeight: 52,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    background: "#111827",
    color: "#e5e7eb",
    border: "1px solid #374151",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 650,
  },
  disabledAction: {
    minHeight: 52,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    background: "#111827",
    color: "#6b7280",
    border: "1px solid #1f2937",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 650,
  },
  url: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    opacity: 0.75,
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
};
