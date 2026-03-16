import type { StreamEventEnvelope } from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import { useMemo } from "react";
import { CHANNEL_COLORS } from "./helpers";

export function ChatTicker({ events }: { events: StreamEventEnvelope[] }) {
  const { t } = useApp();
  // Build ticker entries directly from inbound message events (retake, discord, etc.)
  const recent = useMemo(() => {
    const entries: Array<{
      id: string;
      from: string;
      text: string;
      source: string;
    }> = [];
    for (const evt of events) {
      if (evt.stream !== "message") continue;
      const payload = evt.payload as Record<string, unknown>;
      if (payload.direction !== "inbound") continue;
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const from =
        (typeof payload.displayName === "string" &&
          payload.displayName.trim()) ||
        (typeof payload.from === "string" && payload.from.trim()) ||
        "";
      const source =
        typeof payload.source === "string" ? payload.source : "retake";
      if (text) {
        entries.push({ id: evt.eventId, from: from || "viewer", text, source });
      }
    }
    return entries.slice(-10);
  }, [events]);

  if (recent.length === 0) return null;

  return (
    <div className="px-4 py-1.5 bg-bg border-t border-border overflow-hidden shrink-0">
      <div className="flex items-center gap-4 text-xs text-muted overflow-x-auto whitespace-nowrap scrollbar-hide">
        <span className="text-[10px] uppercase tracking-wider text-muted shrink-0">
          {t("chatticker.chat")}
        </span>
        {recent.map((entry) => {
          const color = CHANNEL_COLORS[entry.source]?.text;
          return (
            <span key={entry.id} className="shrink-0">
              <span className={color ?? "text-txt"}>@{entry.from}</span>
              <span className="text-txt">: {entry.text.slice(0, 80)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
