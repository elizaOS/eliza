/**
 * Video generation page client component.
 * Handles video generation form, preview, usage tracking, and credit management.
 * Supports multiple video models and displays generation history.
 */

"use client";

import {
  BrandButton,
  BrandCard,
  CornerBrackets,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Image,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useSetPageHeader,
} from "@elizaos/cloud-ui";
import {
  BarChart3,
  CheckCircle2,
  Clock4,
  Download,
  ExternalLink,
  Link2,
  Loader2,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { MONTHLY_CREDIT_CAP } from "@/lib/pricing-constants";
import { cn } from "@/lib/utils";
import type { GeneratedVideo, VideoModelOption, VideoUsageSummary } from "./types";
import { VideoGenerationForm } from "./video-generation-form";
import { VideoPreview } from "./video-preview";

const THUMBNAIL_FALLBACKS = [
  "https://images.unsplash.com/photo-1526318472351-c75fcf07015d?auto=format&fit=crop&w=1600&q=80",
  "https://images.unsplash.com/photo-1482192597420-4817fdd7e8b0?auto=format&fit=crop&w=1600&q=80",
  "https://images.unsplash.com/photo-1489515217757-5fd1be406fef?auto=format&fit=crop&w=1600&q=80",
  "https://images.unsplash.com/photo-1489515217757-b51f1e5363ec?auto=format&fit=crop&w=1600&q=80",
];

const MOCK_VIDEO_BASE_URL = "https://video-placeholder.eliza.ai";
const TIMING_KEYS_IN_PRIORITY = ["inference", "total", "duration"] as const;

import type { FalVideoResponse } from "@/lib/types/video";

const parseDurationEstimate = (estimate?: string): number | undefined => {
  if (!estimate) {
    return undefined;
  }

  const rangeMatch = estimate.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/i);
  if (rangeMatch) {
    const start = parseFloat(rangeMatch[1]);
    const end = parseFloat(rangeMatch[2]);
    return Number.isFinite(start) && Number.isFinite(end) ? (start + end) / 2 : undefined;
  }

  const singleMatch = estimate.match(/(\d+(?:\.\d+)?)/);
  if (singleMatch) {
    const value = parseFloat(singleMatch[1]);
    return Number.isFinite(value) ? value : undefined;
  }

  return undefined;
};

const getDurationFromTimings = (timings?: Record<string, number> | null): number | undefined => {
  if (!timings) {
    return undefined;
  }

  for (const key of TIMING_KEYS_IN_PRIORITY) {
    const value = timings[key];
    if (typeof value === "number" && value > 0) {
      return Math.max(1, Math.round(value / 1000));
    }
  }

  return undefined;
};

const getResolutionLabel = (width?: number, height?: number): string | undefined => {
  if (!width || !height) {
    return undefined;
  }

  return `${width} × ${height}`;
};

const pickFallbackThumbnail = (): string => {
  return THUMBNAIL_FALLBACKS[Math.floor(Math.random() * THUMBNAIL_FALLBACKS.length)];
};

const buildMockVideoUrl = (id: string): string => {
  return `${MOCK_VIDEO_BASE_URL}/${id}.mp4`;
};

interface VideoPageClientProps {
  modelPresets: VideoModelOption[];
  featuredVideo: GeneratedVideo | null;
  usage: VideoUsageSummary;
  recentVideos: GeneratedVideo[];
}

export function VideoPageClient({
  modelPresets,
  featuredVideo,
  usage,
  recentVideos,
}: VideoPageClientProps) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState(
    featuredVideo?.prompt ?? "A cinematic drone shot over a futuristic coastal city at sunset",
  );
  const [selectedModel, setSelectedModel] = useState(
    featuredVideo?.modelId ?? modelPresets[0]?.id ?? "",
  );
  const [currentVideo, setCurrentVideo] = useState<GeneratedVideo | null>(featuredVideo);
  const [historyVideos, setHistoryVideos] = useState<GeneratedVideo[]>(recentVideos);
  const [_usageStats, setUsageStats] = useState<VideoUsageSummary>(usage);
  const [referenceUrl, setReferenceUrl] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [previewVideo, setPreviewVideo] = useState<GeneratedVideo | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  useSetPageHeader({
    title: "Video Studio",
  });

  const selectedPreset = useMemo(() => {
    return modelPresets.find((preset) => preset.id === selectedModel) ?? modelPresets[0] ?? null;
  }, [modelPresets, selectedModel]);

  useEffect(() => {
    // Use queueMicrotask to defer execution and avoid synchronous setState
    queueMicrotask(() => {
      setFormError(null);
    });
  }, []);

  const navigateToGallery = useCallback(() => {
    navigate("/dashboard/gallery?tab=video");
  }, [navigate]);

  const handleHistoryItemClick = useCallback((video: GeneratedVideo) => {
    setPreviewVideo(video);
  }, []);

  const handlePreviewDownload = useCallback((video: GeneratedVideo) => {
    if (!video?.videoUrl) {
      setCopyFeedback("Video will be available after rendering completes.");
      setTimeout(() => setCopyFeedback(null), 2600);
      return;
    }
    window.open(video.videoUrl, "_blank", "noopener,noreferrer");
  }, []);

  const handlePreviewCopyLink = useCallback(async (video: GeneratedVideo) => {
    if (!video?.videoUrl) {
      setCopyFeedback("No video link yet.");
      setTimeout(() => setCopyFeedback(null), 2600);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(video.videoUrl);
      setCopyFeedback("Link copied to clipboard.");
      setTimeout(() => setCopyFeedback(null), 2600);
    }
  }, []);

  const replaceVideoEntry = useCallback((draftId: string, nextVideo: GeneratedVideo) => {
    setHistoryVideos((prev) => prev.map((entry) => (entry.id === draftId ? nextVideo : entry)));

    setCurrentVideo((prev) => (prev && prev.id === draftId ? nextVideo : prev));
  }, []);

  const updateUsageAfterCompletion = useCallback((durationSeconds?: number) => {
    setUsageStats((prev) => {
      const normalizedDuration =
        typeof durationSeconds === "number" && Number.isFinite(durationSeconds)
          ? durationSeconds
          : prev.averageDuration;
      const nextTotal = prev.totalRenders + 1;
      const nextAverage =
        nextTotal > 0
          ? (prev.averageDuration * prev.totalRenders + normalizedDuration) / nextTotal
          : normalizedDuration;

      return {
        ...prev,
        totalRenders: nextTotal,
        monthlyCredits: Math.min(prev.monthlyCredits + 1, MONTHLY_CREDIT_CAP),
        lastGeneration: new Date().toISOString(),
        averageDuration: Number.isFinite(nextAverage) ? nextAverage : prev.averageDuration,
      };
    });
  }, []);

  const _simulateMockCompletion = useCallback(
    (draft: GeneratedVideo) => {
      const duration =
        parseDurationEstimate(
          modelPresets.find((preset) => preset.id === draft.modelId)?.durationEstimate,
        ) ?? 10;
      const mock: GeneratedVideo = {
        ...draft,
        status: "completed",
        isMock: true,
        videoUrl: draft.videoUrl ?? buildMockVideoUrl(draft.id),
        durationSeconds: duration,
        seed: draft.seed ?? Math.floor(Math.random() * 10_000),
        timings: { mock: duration * 1000 },
        failureReason: draft.failureReason,
      };

      replaceVideoEntry(draft.id, mock);
      updateUsageAfterCompletion(duration);
      setStatusMessage("Mock render displayed while the generation API is unavailable.");
    },
    [modelPresets, replaceVideoEntry, updateUsageAfterCompletion],
  );

  const handleGenerate = useCallback(
    async ({
      prompt: inputPrompt,
      model,
      referenceUrl: reference,
    }: {
      prompt: string;
      model: string;
      referenceUrl?: string;
    }) => {
      const trimmedPrompt = inputPrompt.trim();
      if (!trimmedPrompt) {
        setFormError("Enter a descriptive prompt before generating a video.");
        return;
      }

      const chosenModel = model || modelPresets[0]?.id || "custom";
      const now = new Date();
      const draftId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `vd_${Math.floor(Math.random() * 1_000_000)}`;
      const fallbackThumbnail = pickFallbackThumbnail();

      const draft: GeneratedVideo = {
        id: draftId,
        prompt: trimmedPrompt,
        modelId: chosenModel,
        thumbnailUrl: fallbackThumbnail,
        createdAt: now.toISOString(),
        status: "processing",
        durationSeconds: undefined,
        resolution: selectedPreset?.dimensions ?? currentVideo?.resolution,
        referenceUrl: reference?.trim() || undefined,
      };

      setIsGenerating(true);
      setFormError(null);
      setStatusMessage("Submitting job to the video generation API…");

      setCurrentVideo(draft);
      setHistoryVideos((prev) => [draft, ...prev.filter((entry) => entry.id !== draft.id)]);

      toast.info("Video generation started", {
        description: "Your video is being generated. This may take a few minutes.",
      });

      const response = await fetch("/api/v1/generate-video", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          model: chosenModel,
          referenceUrl: reference?.trim() || undefined,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.json();
        const message =
          typeof errorBody?.error === "string"
            ? errorBody.error
            : `Request failed (${response.status})`;
        throw new Error(message);
      }

      const payload: FalVideoResponse = await response.json();
      const durationFromTimings = getDurationFromTimings(payload.timings);
      const resolution = getResolutionLabel(payload.video?.width, payload.video?.height);

      const completed: GeneratedVideo = {
        ...draft,
        id: payload.requestId ?? draft.id,
        requestId: payload.requestId ?? draft.id,
        status: "completed",
        videoUrl: payload.video?.url ?? draft.videoUrl ?? buildMockVideoUrl(draft.id),
        thumbnailUrl: draft.thumbnailUrl,
        seed: payload.seed ?? draft.seed,
        hasNsfwConcepts: payload.has_nsfw_concepts,
        timings: payload.timings ?? null,
        durationSeconds:
          durationFromTimings ?? parseDurationEstimate(selectedPreset?.durationEstimate),
        resolution: resolution ?? draft.resolution,
        failureReason: undefined,
        isMock: false,
      };

      replaceVideoEntry(draft.id, completed);
      updateUsageAfterCompletion(completed.durationSeconds);
      setStatusMessage("Video ready — open it in a new tab or copy the link.");
      setReferenceUrl("");

      if (payload.isFallback) {
        toast.warning("Fallback video generated", {
          description: "Using a sample video due to service unavailability.",
        });
      } else {
        toast.success("Video generated successfully!", {
          description: `Your video is ready. Duration: ${completed.durationSeconds || "N/A"}s`,
        });
      }

      setIsGenerating(false);
    },
    [
      currentVideo?.resolution,
      modelPresets,
      replaceVideoEntry,
      selectedPreset,
      updateUsageAfterCompletion,
    ],
  );

  const [activeTab, setActiveTab] = React.useState("generate");
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  return (
    <Tabs
      id="video-tabs"
      value={activeTab}
      onValueChange={setActiveTab}
      className="w-full flex flex-col pb-6 md:pb-8"
    >
      {/* Mobile Dropdown */}
      {isMounted && (
        <div className="block md:hidden mb-3">
          <Select value={activeTab} onValueChange={setActiveTab}>
            <SelectTrigger className="w-full h-10 rounded-sm border border-white/10 bg-transparent text-white">
              <SelectValue>
                <div className="flex items-center gap-2">
                  {activeTab === "generate" && (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Generate</span>
                    </>
                  )}
                  {activeTab === "activity" && (
                    <>
                      <BarChart3 className="h-3.5 w-3.5" />
                      <span>Activity</span>
                      {historyVideos.length > 0 && (
                        <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full bg-white/10">
                          {historyVideos.length}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="bg-[#1A1A1A] border-white/10">
              <SelectItem
                value="generate"
                className="text-white cursor-pointer hover:bg-[#FF5800]/10 focus:bg-[#FF5800]/10"
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate
                </div>
              </SelectItem>
              <SelectItem
                value="activity"
                className="text-white cursor-pointer hover:bg-[#FF5800]/10 focus:bg-[#FF5800]/10"
              >
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-3.5 w-3.5" />
                  Activity
                  {historyVideos.length > 0 && (
                    <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full bg-white/10">
                      {historyVideos.length}
                    </span>
                  )}
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Desktop Tab Navigation */}
      <TabsList className="hidden md:flex w-full rounded-lg border-b border-white/10 bg-transparent h-10 p-0 justify-start mb-3">
        <TabsTrigger
          value="generate"
          className="rounded-lg data-[state=active]:bg-[#FF5800]/10 data-[state=active]:border-b-2 data-[state=active]:border-[#FF5800] px-4 h-full text-sm"
        >
          <Sparkles className="h-3.5 w-3.5 mr-2" />
          Generate
        </TabsTrigger>
        <TabsTrigger
          value="activity"
          className="rounded-lg data-[state=active]:bg-[#FF5800]/10 data-[state=active]:border-b-2 data-[state=active]:border-[#FF5800] px-4 h-full text-sm"
        >
          <BarChart3 className="h-3.5 w-3.5 mr-2" />
          Activity
          {historyVideos.length > 0 && (
            <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full bg-white/10">
              {historyVideos.length}
            </span>
          )}
        </TabsTrigger>
      </TabsList>

      {/* Generate Tab Content */}
      <TabsContent value="generate" className="mt-0">
        <section className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6">
          <VideoGenerationForm
            prompt={prompt}
            onPromptChange={setPrompt}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            models={modelPresets}
            referenceUrl={referenceUrl}
            onReferenceChange={setReferenceUrl}
            onGenerate={(payload) => {
              void handleGenerate(payload);
            }}
            isSubmitting={isGenerating}
            errorMessage={formError}
            statusMessage={statusMessage}
          />
          <VideoPreview video={currentVideo} />
        </section>
      </TabsContent>

      {/* Activity Tab Content */}
      <TabsContent value="activity" className="mt-0">
        <section className="w-full">
          <BrandCard className="relative flex h-full flex-col" id="recent-renders">
            <CornerBrackets size="sm" className="opacity-50" />

            <div className="relative z-10 mb-4">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono font-bold text-[#e1e1e1] uppercase">
                  Recent renders
                </h3>
              </div>
            </div>

            <div className="relative z-10 flex-1 space-y-3 md:space-y-4 overflow-y-auto max-h-[600px]">
              {historyVideos.map((video) => (
                <div
                  key={video.id}
                  onClick={() => handleHistoryItemClick(video)}
                  className="flex gap-3 md:gap-4 border border-white/10 bg-black/40 p-3 md:p-4 rounded-lg transition-colors hover:border-[#FF5800]/50 cursor-pointer group"
                >
                  {/* Thumbnail/Preview */}
                  <div className="relative flex-shrink-0 w-24 md:w-32 aspect-video bg-black/60 border border-white/10 rounded-lg overflow-hidden">
                    {video.videoUrl ? (
                      <video
                        src={video.videoUrl}
                        className="absolute inset-0 w-full h-full object-cover"
                        preload="metadata"
                        muted
                      />
                    ) : video.thumbnailUrl ? (
                      <Image
                        src={video.thumbnailUrl}
                        alt={video.prompt}
                        fill
                        className="object-cover"
                        sizes="128px"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-black/40 to-black/80">
                        <Play className="h-6 w-6 text-white/40" />
                      </div>
                    )}
                    {/* Play overlay */}
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                      <Play className="h-6 w-6 text-[#FF5800] opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    {/* Status indicator on thumbnail */}
                    {video.status === "processing" && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
                      </div>
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "px-2 md:px-3 py-1 text-xs font-mono font-bold uppercase tracking-wide border capitalize flex-shrink-0",
                          video.status === "completed"
                            ? video.isMock
                              ? "bg-white/10 text-white/80 border-white/20"
                              : "bg-green-500/20 text-green-400 border-green-500/40"
                            : video.status === "processing"
                              ? "bg-blue-500/20 text-blue-400 border-blue-500/40"
                              : "bg-rose-500/20 text-rose-400 border-rose-500/40",
                        )}
                      >
                        {video.status}
                      </span>
                      {video.isMock ? (
                        <span className="bg-white/10 px-2 md:px-2.5 py-0.5 text-[11px] font-mono uppercase tracking-wide text-white/60 flex-shrink-0">
                          Mock
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs md:text-sm font-mono font-medium text-white break-words line-clamp-2">
                      {video.prompt}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 md:gap-3 text-xs font-mono text-white/60">
                      <span className="flex items-center gap-1 flex-shrink-0">
                        <CheckCircle2 className="h-3.5 w-3.5 text-[#FF5800]" />
                        <span className="truncate max-w-[120px]">
                          {video.modelId.split("/").pop()}
                        </span>
                      </span>
                      <span className="flex items-center gap-1 flex-shrink-0">
                        <Clock4 className="h-3.5 w-3.5 text-[#FF5800]" />
                        {video.durationSeconds
                          ? `${video.durationSeconds}s`
                          : video.status === "processing"
                            ? "Rendering"
                            : "Pending"}
                      </span>
                      <span className="flex-shrink-0">
                        {new Date(video.createdAt).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    {video.requestId ? (
                      <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-white/50">
                        <span className="font-medium text-white/80 flex-shrink-0">ID:</span>
                        <span className="break-all">{video.requestId}</span>
                      </div>
                    ) : null}
                    {video.failureReason && video.status !== "completed" ? (
                      <div className="text-[11px] font-mono text-rose-400 break-words">
                        {video.failureReason}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
              {historyVideos.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center border border-dashed border-white/10 bg-black/20 p-6 text-center text-xs md:text-sm font-mono text-white/60">
                  <Loader2 className="mb-2 h-5 w-5 animate-spin text-[#FF5800]" />
                  No renders yet — submit a prompt to get started.
                </div>
              )}
            </div>

            <div className="relative z-10 border-t border-white/10 pt-3 md:pt-4 mt-3 md:mt-4">
              <button
                type="button"
                onClick={navigateToGallery}
                className="w-full px-4 py-2 border border-white/20 bg-transparent text-white hover:bg-white/5 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <span className="font-mono text-sm">View full history</span>
                <ExternalLink className="h-4 w-4" />
              </button>
            </div>
          </BrandCard>
        </section>
      </TabsContent>

      {/* Video Preview Dialog */}
      <Dialog open={!!previewVideo} onOpenChange={(open) => !open && setPreviewVideo(null)}>
        <DialogContent
          className="!max-w-[99vw] !max-h-[99vh] !w-[99vw] !h-[99vh] p-0 bg-black/95 border-white/10 sm:!max-w-[99vw] md:!max-w-[99vw] lg:!max-w-[99vw]"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{previewVideo?.prompt || "Video preview"}</DialogTitle>
          {previewVideo && (
            <div className="relative w-full h-full flex items-center justify-center p-4 md:p-6">
              {/* Main Content */}
              <div className="relative w-full h-full flex items-center justify-center pb-48 md:pb-56">
                {previewVideo.videoUrl ? (
                  <video
                    key={previewVideo.videoUrl}
                    src={previewVideo.videoUrl}
                    controls
                    autoPlay
                    className="max-w-full max-h-full object-contain"
                  />
                ) : previewVideo.status === "processing" ? (
                  <div className="flex flex-col items-center justify-center gap-4 text-center">
                    <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
                    <p className="text-lg font-mono font-medium text-white">
                      Video is still rendering...
                    </p>
                    <p className="text-sm font-mono text-white/60">Check back in a few moments.</p>
                  </div>
                ) : previewVideo.status === "failed" ? (
                  <div className="flex flex-col items-center justify-center gap-4 text-center">
                    <div className="rounded-full bg-rose-500/20 border border-rose-500/40 p-4">
                      <X className="h-8 w-8 text-rose-400" />
                    </div>
                    <p className="text-lg font-mono font-medium text-white">Generation failed</p>
                    <p className="text-sm font-mono text-rose-400 max-w-md">
                      {previewVideo.failureReason || "An error occurred during video generation."}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center gap-4 text-center">
                    <Play className="h-12 w-12 text-white/40" />
                    <p className="text-sm font-mono text-white/60">Video not available yet.</p>
                  </div>
                )}
              </div>

              {/* Close button */}
              <DialogClose className="absolute top-4 right-4 z-50 rounded-lg border border-white/20 bg-black/60 p-2 hover:bg-[#FF580020] hover:border-[#FF5800]/40 transition-colors">
                <X className="h-5 w-5 text-white" />
              </DialogClose>

              {/* Info overlay at bottom */}
              <div className="absolute bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/95 via-black/80 to-transparent px-6 pt-8 pb-6 md:px-8 md:pt-12 md:pb-8 space-y-3 max-h-[50vh] overflow-y-auto">
                {/* Status Badge */}
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "px-3 py-1 text-xs font-mono font-bold uppercase tracking-wide border",
                      previewVideo.status === "completed"
                        ? "bg-green-500/20 text-green-400 border-green-500/40"
                        : previewVideo.status === "processing"
                          ? "bg-blue-500/20 text-blue-400 border-blue-500/40"
                          : "bg-rose-500/20 text-rose-400 border-rose-500/40",
                    )}
                  >
                    {previewVideo.status}
                  </span>
                  {previewVideo.isMock && (
                    <span className="bg-white/10 px-2.5 py-1 text-xs font-mono uppercase tracking-wide text-white/60">
                      Mock
                    </span>
                  )}
                </div>

                {/* Prompt */}
                <p className="text-sm text-white/90 leading-relaxed max-w-4xl break-words">
                  {previewVideo.prompt}
                </p>

                {/* Details - Inline compact layout */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                  <div className="flex items-baseline gap-2">
                    <span className="text-white/50 uppercase tracking-wide">Model:</span>
                    <span className="text-white font-medium">
                      {previewVideo.modelId.split("/").pop()}
                    </span>
                  </div>

                  {previewVideo.durationSeconds && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-white/50 uppercase tracking-wide">Duration:</span>
                      <span className="text-white font-medium">
                        {previewVideo.durationSeconds}s
                      </span>
                    </div>
                  )}

                  {previewVideo.resolution && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-white/50 uppercase tracking-wide">Resolution:</span>
                      <span className="text-white font-medium">{previewVideo.resolution}</span>
                    </div>
                  )}

                  {previewVideo.seed && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-white/50 uppercase tracking-wide">Seed:</span>
                      <span className="text-white font-medium">{previewVideo.seed}</span>
                    </div>
                  )}

                  <div className="flex items-baseline gap-2">
                    <span className="text-white/50 uppercase tracking-wide">Created:</span>
                    <span className="text-white font-medium">
                      {new Date(previewVideo.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>

                {previewVideo.requestId && (
                  <div className="text-xs font-mono text-white/50">
                    <span className="text-white/70">ID:</span> {previewVideo.requestId}
                  </div>
                )}

                {/* Action Buttons */}
                {previewVideo.videoUrl && (
                  <div className="flex items-center gap-2 pt-2">
                    <BrandButton
                      variant="outline"
                      size="sm"
                      onClick={() => handlePreviewDownload(previewVideo)}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </BrandButton>
                    <BrandButton
                      variant="outline"
                      size="sm"
                      onClick={() => handlePreviewCopyLink(previewVideo)}
                    >
                      <Link2 className="w-4 h-4 mr-2" />
                      Copy link
                    </BrandButton>
                  </div>
                )}

                {copyFeedback && <p className="text-xs font-mono text-white/60">{copyFeedback}</p>}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
