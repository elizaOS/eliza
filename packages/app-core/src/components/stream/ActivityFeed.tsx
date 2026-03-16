import type { StreamEventEnvelope } from "@elizaos/app-core/api";
import { formatTime } from "@elizaos/app-core/components";
import { useApp } from "@elizaos/app-core/state";
import { useEffect, useRef } from "react";
import {
  CHANNEL_COLORS,
  getEventFrom,
  getEventSource,
  getEventText,
} from "./helpers";

export function ActivityFeed({ events }: { events: StreamEventEnvelope[] }) {
  const { t } = useApp();
  const feedRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  useEffect(() => {
    if (events.length > prevLenRef.current && feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
    prevLenRef.current = events.length;
  }, [events.length]);

  return (
    <div className="flex flex-col h-full border-l border-border bg-bg">
      <div className="px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-bold uppercase tracking-wider text-muted">
          {t("activityfeed.Activity")}
        </span>
      </div>
      <div
        ref={feedRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2"
      >
        {events.length === 0 ? (
          <div className="text-muted text-xs py-4 text-center">
            {t("activityfeed.NoEventsYet")}
          </div>
        ) : (
          events.map((event) => {
            const isThought = event.stream === "thought";
            const isAction = event.stream === "action";
            const isAssistant = event.stream === "assistant";
            const isMessage = event.stream === "message";
            const isNewViewer = event.stream === "new_viewer";
            const source = getEventSource(event);
            const from = getEventFrom(event);
            const channelStyle =
              isMessage || isNewViewer
                ? (CHANNEL_COLORS[source] ?? null)
                : null;
            return (
              <div
                key={event.eventId}
                className={`rounded border px-2 py-1.5 ${
                  isNewViewer
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : isThought
                      ? "border-yellow-500/30 bg-yellow-500/5"
                      : isAction
                        ? "border-blue-500/30 bg-blue-500/5"
                        : isAssistant
                          ? "border-green-500/30 bg-green-500/5"
                          : channelStyle
                            ? `${channelStyle.border} ${channelStyle.bg}`
                            : "border-border"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-[11px] font-semibold uppercase ${
                      isNewViewer
                        ? "text-emerald-400"
                        : isThought
                          ? "text-yellow-400"
                          : isAction
                            ? "text-blue-400"
                            : isAssistant
                              ? "text-green-400"
                              : channelStyle
                                ? channelStyle.text
                                : "text-txt"
                    }`}
                  >
                    {isNewViewer
                      ? "new viewer"
                      : isThought
                        ? "thought"
                        : isAction
                          ? "action"
                          : from
                            ? `@${from}`
                            : `[${source}]`}
                  </span>
                  <span className="text-[10px] text-muted">
                    {formatTime(event.ts, { fallback: "" })}
                  </span>
                </div>
                <div
                  className={`text-[12px] mt-0.5 break-words line-clamp-3 ${
                    isThought ? "text-yellow-200/70 italic" : "text-txt"
                  }`}
                >
                  {getEventText(event)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
