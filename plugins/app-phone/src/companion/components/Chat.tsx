import type React from "react";
import { useEffect, useState } from "react";
import { agentUrl as configuredAgentUrl, logger } from "../services";

interface ChatProps {
  pairedAgentUrl: string | null;
  onOpenPairing(): void;
  onOpenRemoteSession(): void;
  remoteSessionAvailable: boolean;
}

interface MirroredMessage {
  id: string;
  author: "user" | "agent";
  text: string;
  timestampIso: string;
}

/**
 * Chat mirror view. SSE stream + composer land with T9a (data plane) — this
 * view renders the resolved agent URL, the paired-session entry point when
 * a session-start intent is live, and a placeholder empty state.
 */
export function Chat({
  pairedAgentUrl,
  onOpenPairing,
  onOpenRemoteSession,
  remoteSessionAvailable,
}: ChatProps): React.JSX.Element {
  const resolvedAgentUrl = pairedAgentUrl ?? configuredAgentUrl();
  const [messages] = useState<MirroredMessage[]>([]);

  useEffect(() => {
    logger.info("[Chat] mount", {
      resolvedAgentUrl,
      remoteSessionAvailable,
    });
  }, [resolvedAgentUrl, remoteSessionAvailable]);

  return (
    <main style={styles.root}>
      <header style={styles.header}>
        <div style={styles.headerRow}>
          <h2 style={styles.title}>Eliza</h2>
          <div style={styles.actions}>
            {remoteSessionAvailable ? (
              <button
                type="button"
                onClick={onOpenRemoteSession}
                style={styles.primaryAction}
              >
                Open remote session
              </button>
            ) : null}
            <button
              type="button"
              onClick={onOpenPairing}
              style={styles.secondaryAction}
            >
              {resolvedAgentUrl === null ? "Pair" : "Re-pair"}
            </button>
          </div>
        </div>
        <span style={styles.url}>{resolvedAgentUrl ?? "no agent URL"}</span>
      </header>
      <section style={styles.body}>
        {messages.length === 0 ? (
          <p style={styles.empty}>
            No messages yet. Chat streaming is delivered by T9a (data plane).
          </p>
        ) : (
          messages.map((message) => (
            <article key={message.id} style={styles.message}>
              <strong>{message.author}</strong>
              <span>{message.text}</span>
            </article>
          ))
        )}
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
  header: {
    padding: "16px 20px",
    borderBottom: "1px solid #1f2937",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  title: { margin: 0, fontSize: 20 },
  actions: { display: "flex", gap: 8 },
  primaryAction: {
    padding: "8px 12px",
    background: "#4f46e5",
    color: "#fff",
    border: "none",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
  },
  secondaryAction: {
    padding: "8px 12px",
    background: "#111",
    color: "#e5e7eb",
    border: "1px solid #374151",
    borderRadius: 999,
    fontSize: 13,
  },
  url: { opacity: 0.6, fontSize: 12, fontFamily: "ui-monospace, monospace" },
  body: {
    flex: 1,
    padding: 20,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  empty: { opacity: 0.6, margin: 0 },
  message: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    background: "#111",
    padding: 12,
    borderRadius: 12,
  },
};
