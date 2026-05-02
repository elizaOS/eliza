/**
 * Video preview component displaying generated video with playback controls.
 * Supports video playback, download, URL copying, and moderation flag display.
 *
 * @param props - Video preview configuration
 * @param props.video - Generated video data to display
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { Clock, Download, Link2, Loader2, Play, ShieldAlert, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { GeneratedVideo } from "./types";

interface VideoPreviewProps {
  video?: GeneratedVideo | null;
}

export function VideoPreview({ video }: VideoPreviewProps) {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasModerationFlag = video?.hasNsfwConcepts?.some(Boolean) ?? false;
  const timingMs = video?.timings
    ? (video.timings.inference ?? video.timings.total ?? video.timings.duration)
    : undefined;
  const processingTimeLabel =
    typeof timingMs === "number"
      ? timingMs >= 1000
        ? `${(timingMs / 1000).toFixed(1)}s`
        : `${Math.round(timingMs)}ms`
      : null;

  const showFeedback = useCallback((message: string) => {
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
    }

    setCopyFeedback(message);
    feedbackTimeoutRef.current = setTimeout(() => {
      setCopyFeedback(null);
      feedbackTimeoutRef.current = null;
    }, 2600);
  }, []);

  const handleDownload = useCallback(() => {
    if (!video?.videoUrl) {
      showFeedback("Video will be available after rendering completes.");
      return;
    }

    window.open(video.videoUrl, "_blank", "noopener,noreferrer");
    showFeedback("Opening video in a new tab.");
  }, [showFeedback, video]);

  const handleCopyLink = useCallback(async () => {
    if (!video?.videoUrl) {
      showFeedback("No video link yet — generate a clip first.");
      return;
    }

    if (typeof navigator === "undefined" || !navigator.clipboard) {
      showFeedback("Clipboard access unavailable in this browser.");
      return;
    }

    await navigator.clipboard.writeText(video.videoUrl);
    showFeedback("Link copied to clipboard.");
  }, [showFeedback, video]);

  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        clearTimeout(feedbackTimeoutRef.current);
      }
    };
  }, []);

  return (
    <BrandCard className="relative flex h-full min-h-0 flex-col">
      <CornerBrackets size="md" className="opacity-50" />

      <div className="relative z-10 space-y-2 pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
            <h3 className="text-base md:text-lg lg:text-xl font-mono font-bold text-[#e1e1e1] uppercase">
              Preview
            </h3>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {(!video || video.status !== "completed") && (
              <span
                className={cn(
                  "px-2 md:px-3 py-1 text-xs font-mono font-bold uppercase tracking-wide border whitespace-nowrap",
                  video
                    ? video.status === "processing"
                      ? "bg-blue-500/20 text-blue-400 border-blue-500/40"
                      : "bg-rose-500/20 text-rose-400 border-rose-500/40"
                    : "bg-white/10 text-white/60 border-white/20",
                )}
              >
                {video ? video.status : "Idle"}
              </span>
            )}
            {video?.isMock ? (
              <span className="bg-white/10 px-2 md:px-3 py-1 text-xs font-mono text-white/60 whitespace-nowrap">
                Mock
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="relative z-10 flex-1 min-h-0 pb-0 mt-4 md:mt-6">
        <div className="relative aspect-video w-full overflow-hidden border border-white/10 bg-black/60 shadow-inner">
          {video ? (
            <>
              {video.videoUrl ? (
                <video
                  key={video.videoUrl}
                  src={video.videoUrl}
                  controls
                  className="absolute inset-0 h-full w-full object-cover"
                  preload="metadata"
                />
              ) : (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-black/40 via-black/70 to-black/90 text-center px-4"
                  style={
                    video.thumbnailUrl
                      ? {
                          backgroundImage: `url(${video.thumbnailUrl})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }
                      : undefined
                  }
                >
                  {!video.thumbnailUrl && (
                    <>
                      <Play className="h-8 md:h-10 w-8 md:w-10 text-white/50" />
                      <p className="mt-3 text-xs md:text-sm font-mono text-white/60">
                        Generated video preview
                      </p>
                    </>
                  )}
                </div>
              )}
              {video.status === "processing" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-center px-4">
                  <Loader2 className="h-6 md:h-8 w-6 md:w-8 animate-spin text-[#FF5800]" />
                  <p className="text-xs md:text-sm font-mono font-medium text-white">
                    Sending job to Fal…
                  </p>
                  <p className="text-xs font-mono text-white/60">
                    This usually takes a few moments.
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-white/60 px-4">
              <Sparkles className="h-8 md:h-10 w-8 md:w-10 text-[#FF5800]" />
              <p className="text-xs md:text-sm font-mono font-medium text-white">
                Your video will appear here once generated.
              </p>
              <p className="text-xs font-mono text-white/60">
                Use the form to create a concept and track progress in real time.
              </p>
            </div>
          )}
        </div>

        <div className="mt-4 md:mt-6 grid gap-3 md:gap-4 border border-white/10 bg-black/40 p-3 md:p-4 text-xs md:text-sm">
          <div className="space-y-1">
            <p className="text-xs font-mono font-semibold uppercase tracking-wide text-white/70">
              Prompt
            </p>
            <p className="text-xs md:text-sm font-mono text-white break-words">
              {video?.prompt ?? "No prompt yet — craft a description to begin."}
            </p>
          </div>
          <div className="grid gap-2 text-xs font-mono text-white/60">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Model preset</span>
              <span className="font-medium text-white break-all text-right">
                {video?.modelId ?? "Not selected"}
              </span>
            </div>
            {video?.requestId ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Request ID</span>
                <span className="font-medium text-white break-all text-right">
                  {video.requestId}
                </span>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-[#FF5800]" /> Duration
              </span>
              <span className="font-medium text-white">
                {video?.durationSeconds
                  ? `${video.durationSeconds}s`
                  : video?.status === "processing"
                    ? "Rendering"
                    : "Pending"}
              </span>
            </div>
            {processingTimeLabel ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Processing time</span>
                <span className="font-medium text-white">{processingTimeLabel}</span>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Resolution</span>
              <span className="font-medium text-white">{video?.resolution ?? "—"}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Seed</span>
              <span className="font-medium text-white">{video?.seed ?? "Auto"}</span>
            </div>
            {video?.referenceUrl ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Reference</span>
                <a
                  href={video.referenceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-[#FF5800] hover:underline break-all text-right"
                >
                  Open link
                </a>
              </div>
            ) : null}
          </div>
        </div>

        {video?.failureReason ? (
          <div
            className={cn(
              "mt-3 md:mt-4 border px-3 md:px-4 py-2 md:py-3 text-xs font-mono leading-relaxed break-words",
              video.status === "failed"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-300",
            )}
          >
            {video.status === "failed"
              ? `Generation failed: ${video.failureReason}`
              : `API response: ${video.failureReason}. Displaying cached/mock preview.`}
          </div>
        ) : null}
        {hasModerationFlag ? (
          <div className="mt-3 flex items-start gap-2 border border-amber-500/40 bg-amber-500/10 px-3 md:px-4 py-2 md:py-3 text-xs font-mono text-amber-300">
            <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>
              Potential safety flags were returned for this render. Review before sharing publicly.
            </span>
          </div>
        ) : null}
      </div>

      <div className="relative z-10 flex flex-col gap-2 md:gap-3 border-t border-white/10 pt-3 md:pt-4 mt-3 md:mt-4">
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-white/60">
          <span>Last generated</span>
          <span className="font-medium text-white">
            {video?.createdAt ? new Date(video.createdAt).toLocaleString() : "—"}
          </span>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={handleDownload}
            className="relative bg-[#e1e1e1] px-4 py-2 overflow-hidden hover:bg-white transition-colors flex-1"
          >
            <div
              className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
              style={{
                backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                backgroundSize: "2.915576934814453px 2.915576934814453px",
              }}
            />
            <span className="relative z-10 text-black font-mono font-medium text-sm flex items-center justify-center gap-2">
              <Download className="h-4 w-4" />
              Download
            </span>
          </button>
          <button
            type="button"
            onClick={handleCopyLink}
            className="px-4 py-2 border border-white/20 bg-transparent text-white hover:bg-white/5 transition-colors flex-1"
          >
            <span className="font-mono text-sm flex items-center justify-center gap-2">
              <Link2 className="h-4 w-4" />
              Copy link
            </span>
          </button>
        </div>
        {copyFeedback && (
          <p className="text-center text-xs font-mono text-white/60">{copyFeedback}</p>
        )}
      </div>
    </BrandCard>
  );
}
