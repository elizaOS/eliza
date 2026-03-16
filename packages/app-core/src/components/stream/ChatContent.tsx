import type {
  ConversationMessage,
  StreamEventEnvelope,
} from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import { useEffect, useMemo, useRef } from "react";
import { CHANNEL_COLORS, getEventSource, getEventText } from "./helpers";

export function ChatContent({
  events,
  messages,
}: {
  events: StreamEventEnvelope[];
  messages: ConversationMessage[];
}) {
  const { t } = useApp();
  const scrollRef = useRef<HTMLDivElement>(null);

  const recentExchanges = useMemo(() => {
    const exchanges: Array<{
      id: string;
      role: "user" | "assistant" | "event";
      text: string;
      source?: string;
      from?: string;
      ts: number;
    }> = [];

    // Build lookup from events for username resolution
    const eventFromLookup = new Map<string, string>();
    for (const evt of events) {
      if (evt.stream !== "message") continue;
      const p = evt.payload as Record<string, unknown>;
      const text = typeof p.text === "string" ? p.text.trim() : "";
      const from = typeof p.from === "string" ? p.from : "";
      if (text && from) eventFromLookup.set(text, from);
    }

    for (const msg of messages.slice(-8)) {
      exchanges.push({
        id: msg.id,
        role: msg.role,
        text: msg.text,
        source: msg.source,
        from: msg.from ?? eventFromLookup.get(msg.text.trim()),
        ts: msg.timestamp,
      });
    }

    const assistantEvents = events
      .filter((e) => e.stream === "assistant")
      .slice(-4);
    for (const evt of assistantEvents) {
      const text = getEventText(evt);
      if (!exchanges.some((e) => e.text === text)) {
        exchanges.push({
          id: evt.eventId,
          role: "event",
          text,
          source: getEventSource(evt),
          ts: evt.ts,
        });
      }
    }

    return exchanges.sort((a, b) => a.ts - b.ts).slice(-10);
  }, [events, messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-y-auto px-5 py-4 space-y-3"
    >
      {recentExchanges.length === 0 ? (
        <div className="flex items-center justify-center h-full text-muted text-sm">
          {t("chatcontent.WaitingForMessages")}
        </div>
      ) : (
        recentExchanges.map((exchange) => {
          const channelStyle =
            exchange.role === "user" && exchange.source
              ? CHANNEL_COLORS[exchange.source]
              : undefined;
          return (
            <div
              key={exchange.id}
              className={`flex ${
                exchange.role === "assistant" || exchange.role === "event"
                  ? "justify-end"
                  : "justify-start"
              }`}
            >
              <div
                className={`max-w-[75%] rounded-lg px-4 py-2.5 ${
                  exchange.role === "assistant" || exchange.role === "event"
                    ? "bg-accent/20 text-txt-strong"
                    : channelStyle
                      ? `${channelStyle.bg} text-txt border ${channelStyle.border}`
                      : "bg-bg-muted text-txt"
                }`}
              >
                <div
                  className={`text-[10px] uppercase mb-1 ${channelStyle?.text ?? "text-muted"}`}
                >
                  {exchange.role === "user"
                    ? exchange.from
                      ? `@${exchange.from}`
                      : (exchange.source ?? "viewer")
                    : "agent"}
                </div>
                <div className="text-sm leading-relaxed break-words">
                  {exchange.text}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
