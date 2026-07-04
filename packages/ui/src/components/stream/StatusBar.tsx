/**
 * Bottom status bar for the agent screen-stream view: agent name, live/idle
 * indicator, uptime, frame count, and the start/stop-stream toggle. On the web
 * it also offers a pop-out button that opens the stream in a separate window
 * (`openStreamPopout`); the Electrobun desktop runtime uses its own native
 * window path, so the web pop-out is suppressed there.
 */
import { ExternalLink } from "lucide-react";
import { type CSSProperties, useEffect, useRef } from "react";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { getBootConfig } from "../../config/boot-config";
import { useAppSelector } from "../../state";
import { formatUptime } from "../../utils/format";
import { Button } from "../ui/button";
import { IS_POPOUT } from "./helpers";
import { openStreamPopout } from "./popout-url";

export function StatusBar({
  agentName,
  streamAvailable,
  streamLive,
  streamLoading,
  onToggleStream,
  uptime,
  frameCount,
}: {
  agentName: string;
  streamAvailable: boolean;
  streamLive: boolean;
  streamLoading: boolean;
  onToggleStream: () => void;
  uptime: number;
  frameCount: number;
}) {
  const t = useAppSelector((s) => s.t);
  const isElectrobun = isElectrobunRuntime();
  const popoutPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (popoutPollRef.current) {
        clearInterval(popoutPollRef.current);
        popoutPollRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className="flex items-center justify-between bg-card/80 shrink-0 px-3 py-2 lg:px-4"
      style={
        IS_POPOUT ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined
      }
    >
      <div className="flex items-center gap-2">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            streamLive ? "bg-danger   animate-pulse" : "bg-muted"
          }`}
        />
        <span className="text-xs font-bold uppercase tracking-wider text-txt">
          {streamLive
            ? t("statusbar.LiveShort", { defaultValue: "LIVE" })
            : t("statusbar.OfflineShort", { defaultValue: "OFFLINE" })}
        </span>
        <span className="text-sm font-semibold text-txt-strong">
          {agentName}
        </span>
      </div>

      <div
        className="flex items-center gap-2 lg:gap-3 text-xs text-muted"
        style={
          IS_POPOUT
            ? ({ WebkitAppRegion: "no-drag" } as CSSProperties)
            : undefined
        }
      >
        {/* Health stats — live only */}
        {streamLive && (
          <span className="inline-flex min-h-9 items-center gap-1.5 rounded-sm bg-card/92 px-2.5 py-1.5 text-xs-tight text-muted-strong font-mono text-2xs">
            <span className="text-txt">{formatUptime(uptime)}</span>
            <span className="text-muted">·</span>
            <span className="text-txt">
              {frameCount.toLocaleString("en-US")}f
            </span>
          </span>
        )}

        <Button
          size="sm"
          disabled={!streamAvailable || streamLoading}
          // Go Live is the primary action → accent, not a green status tint
          // (orange is the only accent, #10710). Stop Stream stays danger —
          // that chrome is semantic (destructive).
          className={`inline-flex min-h-11 items-center justify-center rounded-sm px-3 text-xs-tight font-semibold uppercase tracking-[0.16em] transition-[background-color,color,box-shadow] disabled:cursor-wait disabled:opacity-50 ${
            streamLive
              ? "bg-danger/10 text-danger hover:bg-danger/20"
              : "bg-accent/10 text-accent hover:bg-accent/20"
          }`}
          onClick={onToggleStream}
          title={
            streamAvailable
              ? undefined
              : t("statusbar.InstallStreamingPlugin", {
                  defaultValue:
                    "Install and enable the streaming plugin to go live",
                })
          }
        >
          {streamLoading
            ? "..."
            : streamLive
              ? t("statusbar.StopStream", { defaultValue: "Stop Stream" })
              : t("statusbar.GoLive", { defaultValue: "Go Live" })}
        </Button>

        {/* Popout button — non-Electrobun only */}
        {!IS_POPOUT && !isElectrobun && (
          <Button
            variant="ghost"
            size="sm"
            className="inline-flex h-11 min-h-11 w-11 items-center justify-center rounded-sm bg-card/92 px-0 py-1.5 text-xs-tight text-muted-strong transition-[background-color,color,box-shadow] hover:bg-bg-hover hover:text-txt"
            title={t("statusbar.PopOutStreamView")}
            onClick={() => {
              const popoutWin = openStreamPopout(getBootConfig().apiBase);
              if (popoutWin) {
                window.dispatchEvent(
                  new CustomEvent("stream-popout", { detail: "opened" }),
                );
                if (popoutPollRef.current) {
                  clearInterval(popoutPollRef.current);
                }
                popoutPollRef.current = setInterval(() => {
                  if (popoutWin.closed) {
                    if (popoutPollRef.current) {
                      clearInterval(popoutPollRef.current);
                      popoutPollRef.current = null;
                    }
                    window.dispatchEvent(
                      new CustomEvent("stream-popout", { detail: "closed" }),
                    );
                  }
                }, 500);
              }
            }}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
