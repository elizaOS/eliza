import { Button } from "../ui/button";
import { ExternalLink } from "lucide-react";
import { type CSSProperties, useEffect, useRef } from "react";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { getBootConfig } from "../../config/boot-config";
import { useApp } from "../../state/useApp";
import { formatUptime } from "../../utils/format";
import { IS_POPOUT } from "./helpers";

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
  const { t } = useApp();
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
      className="flex items-center justify-between bg-card/80 shadow-sm backdrop-blur-xl shrink-0 px-3 py-2 lg:px-4"
      style={
        IS_POPOUT ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined
      }
    >
      <div className="flex items-center gap-2">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            streamLive
              ? "bg-danger ring-2 ring-danger/25 animate-pulse"
              : "bg-muted"
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
          <span className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-border/45 bg-card/92 px-2.5 py-1.5 text-xs-tight text-muted-strong shadow-sm font-mono text-2xs">
            <span className="text-txt">{formatUptime(uptime)}</span>
            <span className="text-border">|</span>
            <span className="text-txt">{frameCount.toLocaleString()}f</span>
          </span>
        )}

        <Button
          size="sm"
          disabled={!streamAvailable || streamLoading}
          className={`inline-flex h-9 min-h-9 items-center justify-center rounded-xl border px-3 text-xs-tight font-semibold uppercase tracking-[0.16em] shadow-sm transition-[border-color,background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent/35 disabled:cursor-wait disabled:opacity-50 ${
            streamLive
              ? "border-danger/35 bg-danger/10 text-danger hover:border-danger/50 hover:bg-danger/16"
              : "border-ok/35 bg-ok/10 text-ok hover:border-ok/50 hover:bg-ok/16"
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
            className="inline-flex min-h-9 h-9 w-9 items-center justify-center rounded-xl border border-border/45 bg-card/92 px-0 py-1.5 text-xs-tight text-muted-strong shadow-sm transition-[border-color,background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent/35 hover:border-border-strong hover:bg-bg-hover hover:text-txt hover:shadow-md"
            title={t("statusbar.PopOutStreamView")}
            onClick={() => {
              const apiBase = getBootConfig().apiBase;
              const base = window.location.origin || "";
              const sep =
                window.location.protocol === "file:" ||
                window.location.protocol === "electrobun:"
                  ? "#"
                  : "";
              const qs = apiBase
                ? `popout&apiBase=${encodeURIComponent(apiBase)}`
                : "popout";
              const popoutWin = window.open(
                `${base}${sep}/?${qs}`,
                "elizaos-stream",
                "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no",
              );
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
