import type { StreamEventEnvelope } from "@elizaos/app-core/api";
import { formatTime } from "@elizaos/app-core/components";
import { useApp } from "@elizaos/app-core/state";
import { useMemo } from "react";
import { getEventText } from "./helpers";

export function IdleContent({ events }: { events: StreamEventEnvelope[] }) {
  const { t } = useApp();
  const latestThought = useMemo(
    () =>
      [...events]
        .reverse()
        .find((e) => e.stream === "assistant" || e.stream === "evaluator"),
    [events],
  );

  const recentActions = useMemo(
    () =>
      events
        .filter(
          (e) =>
            e.stream === "action" ||
            e.stream === "tool" ||
            e.stream === "provider",
        )
        .slice(-6),
    [events],
  );

  return (
    <div className="h-full w-full flex flex-col justify-center px-8 py-6">
      {latestThought ? (
        <div className="mb-5">
          <div className="text-[10px] uppercase text-muted mb-1">
            {t("idlecontent.Thought")}
          </div>
          <div className="text-base text-txt italic leading-relaxed">
            "{getEventText(latestThought).slice(0, 250)}"
          </div>
        </div>
      ) : (
        <div className="text-muted text-base mb-5">
          {t("idlecontent.AgentIsIdleAwai")}
        </div>
      )}
      {recentActions.length > 0 && (
        <div>
          <div className="text-[10px] uppercase text-muted mb-2">
            {t("idlecontent.RecentActions")}
          </div>
          <div className="space-y-1.5">
            {recentActions.map((a) => (
              <div
                key={a.eventId}
                className="flex items-center gap-2 text-[12px]"
              >
                <span className="text-ok font-mono">
                  {a.stream ?? "action"}
                </span>
                <span className="text-txt truncate">
                  {getEventText(a).slice(0, 80)}
                </span>
                <span className="text-[10px] text-muted ml-auto shrink-0">
                  {formatTime(a.ts, { fallback: "" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
