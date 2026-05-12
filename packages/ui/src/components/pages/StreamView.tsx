import { useDocumentVisibility } from "../../hooks/useDocumentVisibility";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api/client";
import { isApiError } from "../../api/client-types-core";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { getBootConfig } from "../../config/boot-config";
import { useApp } from "../../state/useApp";
import { formatUptime } from "../../utils/format";
import { IS_POPOUT } from "../stream/helpers";
import { StatusBar } from "../stream/StatusBar";

export function StreamView({ inModal }: { inModal?: boolean } = {}) {
  const { agentStatus, t } = useApp();
  const { branding } = getBootConfig();
  const agentName = agentStatus?.agentName ?? branding.appName ?? "Eliza";
  const isElectrobun = isElectrobunRuntime();

  const [streamLive, setStreamLive] = useState(false);
  const [streamLoading, setStreamLoading] = useState(false);
  const loadingRef = useRef(false);
  const docVisible = useDocumentVisibility();
  const [streamAvailable, setStreamAvailable] = useState(true);
  const [uptime, setUptime] = useState(0);
  const [frameCount, setFrameCount] = useState(0);

  // Poll stream status
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      if (loadingRef.current || !streamAvailable) return;
      try {
        const status = await client.streamStatus();
        if (mounted && !loadingRef.current) {
          setStreamLive(status.running && status.ffmpegAlive);
          setUptime(status.uptime);
          setFrameCount(status.frameCount);
        }
      } catch (err: unknown) {
        if (isApiError(err) && err.status === 404) {
          setStreamAvailable(false);
          return;
        }
      }
    };
    if (!streamAvailable || !docVisible) return;
    poll();
    const id = setInterval(poll, 5_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [streamAvailable, docVisible]);

  const toggleStream = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setStreamLoading(true);
    try {
      if (streamLive) {
        await client.streamGoOffline();
        setStreamLive(false);
      } else {
        const result = await client.streamGoLive();
        setStreamLive(result.live);

        if (result.live && !IS_POPOUT && !isElectrobun) {
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
          window.open(
            `${base}${sep}/?${qs}`,
            "elizaos-stream",
            "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no",
          );
        }
      }
    } catch (err) {
      console.warn("[stream] Failed to toggle stream:", err);
      try {
        const status = await client.streamStatus();
        setStreamLive(status.running && status.ffmpegAlive);
      } catch {
        /* poll will recover within 5s */
      }
    } finally {
      loadingRef.current = false;
      setStreamLoading(false);
    }
  }, [isElectrobun, streamLive]);

  return (
    <div
      data-stream-view
      className={`flex flex-col text-txt font-body ${
        inModal ? "bg-transparent" : "bg-bg"
      } h-full w-full`}
    >
      <StatusBar
        agentName={agentName}
        streamAvailable={streamAvailable}
        streamLive={streamLive}
        streamLoading={streamLoading}
        onToggleStream={toggleStream}
        uptime={uptime}
        frameCount={frameCount}
      />

      <div className="flex flex-1 min-h-0 items-center justify-center">
        {!streamAvailable ? (
          <div className="max-w-lg rounded-3xl border border-border/60 bg-card/94 p-6 text-center shadow-xl backdrop-blur-xl">
            <p className="text-xs-tight uppercase tracking-[0.24em] text-muted">
              {t("streamview.StreamingUnavailabl")}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-txt">
              {t("streamview.EnableTheStreaming")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              {t("streamview.CouldNotRea")}{" "}
              <code className="rounded-md border border-border/45 bg-bg-hover px-1.5 py-0.5 text-xs text-txt-strong">
                {t("streamview.streamingBase")}
              </code>{" "}
              {t("streamview.pluginThenReload")}
            </p>
            <p className="mt-4 text-xs text-muted">
              {t("streamview.IfThePluginIsAlr")}
            </p>
          </div>
        ) : (
          <div className="max-w-md rounded-3xl border border-border/60 bg-card/94 p-6 text-center shadow-xl backdrop-blur-xl">
            <div
              className={`mx-auto mb-4 h-3 w-3 rounded-full ${
                streamLive
                  ? "bg-danger ring-4 ring-danger/20 animate-pulse"
                  : "bg-muted"
              }`}
            />
            <h2 className="text-lg font-semibold text-txt">
              {streamLive
                ? t("streamview.StreamIsLive", {
                    defaultValue: "Stream is Live",
                  })
                : t("streamview.StreamReady", {
                    defaultValue: "Stream Ready",
                  })}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {streamLive
                ? t("streamview.StreamLiveStatus", {
                    uptime: formatUptime(uptime),
                    frameCount: frameCount.toLocaleString(),
                    defaultValue: "Uptime: {{uptime}} · {{frameCount}} frames",
                  })
                : t("streamview.GoLiveHint", {
                    defaultValue: "Press Go Live to start streaming.",
                  })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
