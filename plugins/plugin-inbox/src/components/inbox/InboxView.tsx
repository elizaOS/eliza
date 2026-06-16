import type { ReactElement } from "react";
import { useState } from "react";

import type { InboxChannel, ThreadSummary } from "../../types.ts";

/**
 * Minimal InboxView placeholder.
 *
 * MIGRATION STATUS: STUB.
 * The richer UI (thread list, triage drawer, snooze picker, approval queue)
 * will be ported from plugin-lifeops in a follow-up pass. For now this renders
 * the inbox header + empty-state with channel filter chips so the view
 * registers, mounts, and is visually identifiable.
 */

const CHANNEL_CHIPS: { id: InboxChannel; label: string }[] = [
  { id: "email", label: "Email" },
  { id: "discord", label: "Discord" },
  { id: "telegram", label: "Telegram" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "slack", label: "Slack" },
  { id: "x", label: "X" },
  { id: "farcaster", label: "Farcaster" },
  { id: "imessage", label: "iMessage" },
];

export interface InboxViewProps {
  threads?: ThreadSummary[];
}

export function InboxView(props: InboxViewProps): ReactElement {
  const threads = props.threads ?? [];
  const [activeChannels, setActiveChannels] = useState<Set<InboxChannel>>(
    () => new Set<InboxChannel>(),
  );

  const toggleChannel = (channel: InboxChannel): void => {
    setActiveChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channel)) next.delete(channel);
      else next.add(channel);
      return next;
    });
  };

  const visibleThreads =
    activeChannels.size === 0
      ? threads
      : threads.filter((t) => activeChannels.has(t.channel));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "1.5rem",
        gap: "1rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          Inbox
        </h1>
        <p style={{ color: "#888", margin: 0 }}>
          Unified triage across every connected channel.
        </p>
      </header>

      {/* biome-ignore lint/a11y/useSemanticElements: an ARIA group of filter-chip toggles, not a form fieldset */}
      <div
        role="group"
        aria-label="Channel filters"
        style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}
      >
        {CHANNEL_CHIPS.map((chip) => {
          const active = activeChannels.has(chip.id);
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => toggleChannel(chip.id)}
              aria-pressed={active}
              style={{
                padding: "0.35rem 0.75rem",
                borderRadius: 999,
                border: "1px solid",
                borderColor: active ? "#f97316" : "#444",
                background: active ? "#f97316" : "transparent",
                color: active ? "#fff" : "inherit",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      <section
        aria-label="Threads"
        style={{
          flex: 1,
          border: "1px dashed #333",
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#888",
        }}
      >
        {visibleThreads.length === 0 ? (
          <span>No threads to triage.</span>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: "1rem",
              margin: 0,
              width: "100%",
            }}
          >
            {visibleThreads.map((thread) => (
              <li
                key={thread.threadId}
                style={{
                  padding: "0.75rem 0",
                  borderBottom: "1px solid #222",
                }}
              >
                <strong>{thread.subject ?? thread.threadId}</strong>
                <div style={{ fontSize: "0.85rem", color: "#aaa" }}>
                  {thread.channel} — {thread.lastMessagePreview}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default InboxView;
