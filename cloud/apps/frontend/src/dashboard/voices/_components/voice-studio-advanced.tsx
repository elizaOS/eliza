/**
 * Advanced voice studio component with voice management and creation.
 * Supports voice cloning, preview playback, deletion, and status tracking.
 */

"use client";

import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  BrandButton,
  BrandCard,
  CornerBrackets,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@elizaos/cloud-ui";
import {
  getEstimatedReadyMessage,
  VoiceAudioPlayer,
  VoiceStatusBadge,
} from "@elizaos/cloud-ui/components/voice";
import type { Voice as BaseVoice } from "@elizaos/cloud-ui/components/voice/types";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  BarChart3,
  ExternalLink,
  Library,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { VoiceCloneForm } from "./voice-clone-form";

// Extended Voice type with additional fields for studio
interface Voice extends BaseVoice {
  status?: "processing" | "completed" | "failed";
  jobId?: string;
}

interface VoiceStudioAdvancedProps {
  initialVoices: Voice[];
  creditBalance: number;
  onCreditBalanceChange: (balance: number) => void;
}

interface PreviewState {
  voice: Voice | null;
  audioUrl: string | null;
  isLoading: boolean;
}

interface OperationState {
  deleteDialogVoice: Voice | null;
  isDeleting: boolean;
  isRefreshing: boolean;
}

export function VoiceStudioAdvanced({
  initialVoices,
  creditBalance,
  onCreditBalanceChange,
}: VoiceStudioAdvancedProps) {
  const navigate = useNavigate();
  const [voices, setVoices] = useState<Voice[]>(initialVoices);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(voices[0] || null);

  const [previewState, setPreviewState] = useState<PreviewState>({
    voice: null,
    audioUrl: null,
    isLoading: false,
  });

  const [operationState, setOperationState] = useState<OperationState>({
    deleteDialogVoice: null,
    isDeleting: false,
    isRefreshing: false,
  });

  const updatePreview = (updates: Partial<PreviewState>) => {
    setPreviewState((prev) => ({ ...prev, ...updates }));
  };

  const updateOperation = useCallback((updates: Partial<OperationState>) => {
    setOperationState((prev) => ({ ...prev, ...updates }));
  }, []);

  // Manual refresh function
  const manualRefresh = useCallback(async () => {
    updateOperation({ isRefreshing: true });
    const response = await fetch("/api/elevenlabs/voices/user");
    if (response.ok) {
      const data = await response.json();
      if (data.success) {
        setVoices(data.voices);
        toast.success("Voices refreshed");
      }
    }
    updateOperation({ isRefreshing: false });
  }, [updateOperation]);

  const handleVoiceCreated = (newVoice: Voice) => {
    // Check if it's a professional clone (will be processing)
    if (newVoice.cloneType === "professional") {
      toast.success(
        `Voice "${newVoice.name}" is being processed. This may take 30-60 minutes. Refresh the page to check status.`,
        { duration: 8000 },
      );
      // Add with processing status
      setVoices([{ ...newVoice, status: "processing" }, ...voices]);
    } else {
      toast.success(`Voice "${newVoice.name}" created successfully and ready to use!`);
      setVoices([newVoice, ...voices]);
      setSelectedVoice(newVoice);
    }
  };

  const handlePreview = async (voice: Voice) => {
    // Check if professional voice is still processing based on time
    const minutesElapsed = Math.max(
      0,
      (new Date().getTime() - new Date(voice.createdAt).getTime()) / 1000 / 60,
    );
    const isProcessing = voice.cloneType === "professional" && minutesElapsed < 30;

    if (isProcessing) {
      toast.error(
        "Voice is still being processed. Professional voice clones typically take 30-60 minutes. Please check back later.",
        { duration: 6000 },
      );
      return;
    }

    if (!voice.elevenlabsVoiceId) {
      toast.error("Voice ID not available. Voice may still be processing.");
      return;
    }

    updatePreview({ voice, isLoading: true });

    const response = await fetch("/api/elevenlabs/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Hello! This is a preview of your custom voice clone.",
        voiceId: voice.elevenlabsVoiceId,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      const errorMsg = errorData.error || "Failed to generate preview";
      // Check for service unavailable
      if (errorMsg.includes("temporarily unavailable")) {
        toast.error(
          "Voice service is temporarily unavailable. Please try again in a few minutes.",
          { duration: 6000 },
        );
      } else {
        toast.error(errorMsg);
      }
      updatePreview({ voice: null, isLoading: false });
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    updatePreview({ audioUrl: url, isLoading: false });
  };

  const handleDelete = async (voice: Voice) => {
    updateOperation({ isDeleting: true });
    try {
      const response = await fetch(`/api/elevenlabs/voices/${voice.id}`, {
        method: "DELETE",
      });

      if (!response.ok) throw new Error("Failed to delete voice");

      toast.success("Voice deleted successfully");
      setVoices(voices.filter((v) => v.id !== voice.id));
      if (selectedVoice?.id === voice.id) {
        setSelectedVoice(voices[0] || null);
      }
      updateOperation({ deleteDialogVoice: null });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete voice");
    } finally {
      updateOperation({ isDeleting: false });
    }
  };

  const handleUseInTTS = (voice: Voice) => {
    navigate(`/dashboard/chat?voiceId=${voice.elevenlabsVoiceId}`);
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "N/A";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // Count professional voices
  const professionalVoiceCount = voices.filter((v) => v.cloneType === "professional").length;
  const professionalVoicesRemaining = Math.max(0, 1 - professionalVoiceCount);

  return (
    <Tabs
      id="voice-studio-tabs"
      defaultValue="clone"
      className="w-full lg:h-[calc(100vh-180px)] flex flex-col pb-6 md:pb-8"
    >
      {/* Tab Navigation */}
      <TabsList className="rounded-none w-full border-b border-white/10 bg-transparent h-10 p-0 justify-start">
        <TabsTrigger
          value="clone"
          className="rounded-none data-[state=active]:bg-[#FF5800]/10 data-[state=active]:border-b-2 data-[state=active]:border-[#FF5800] px-3 md:px-4 h-full text-xs md:text-sm"
        >
          <Mic className="h-3.5 w-3.5 mr-1 md:mr-2" />
          <span className="hidden sm:inline">Clone Voice</span>
          <span className="sm:hidden">Clone</span>
        </TabsTrigger>
        <TabsTrigger
          value="voices"
          className="rounded-none data-[state=active]:bg-[#FF5800]/10 data-[state=active]:border-b-2 data-[state=active]:border-[#FF5800] px-3 md:px-4 h-full text-xs md:text-sm"
        >
          <Library className="h-3.5 w-3.5 mr-1 md:mr-2" />
          <span className="hidden sm:inline">Voice Library</span>
          <span className="sm:hidden">Library</span>
          {voices.length > 0 && (
            <span className="ml-2 px-1.5 py-0.5 text-xs bg-white/10">{voices.length}</span>
          )}
        </TabsTrigger>
      </TabsList>

      {/* Clone Tab Content */}
      <TabsContent value="clone" className="flex-1 lg:overflow-hidden mt-3 lg:h-full">
        <VoiceCloneForm
          creditBalance={creditBalance}
          onSuccess={handleVoiceCreated}
          onCreditBalanceChange={onCreditBalanceChange}
        />
      </TabsContent>

      {/* Voices Tab Content */}
      <TabsContent value="voices" className="flex-1 lg:overflow-hidden mt-3">
        <BrandCard className="relative flex flex-col h-full overflow-hidden">
          <CornerBrackets size="sm" className="opacity-50" />

          <div className="relative z-10 shrink-0">
            <div className="flex flex-col gap-3 md:gap-4 mb-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                    <h3 className="text-base md:text-lg font-mono font-bold text-[#e1e1e1] uppercase">
                      Voice Library
                    </h3>
                  </div>
                  <p className="text-xs md:text-sm font-mono text-[#858585]">
                    {voices.length} voice{voices.length !== 1 ? "s" : ""}
                    {voices.some((v) => {
                      const mins = Math.max(
                        0,
                        (new Date().getTime() - new Date(v.createdAt).getTime()) / 1000 / 60,
                      );
                      return v.cloneType === "professional" && mins < 60;
                    }) && " • Some may still be processing"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={manualRefresh}
                  disabled={operationState.isRefreshing}
                  className="inline-flex items-center gap-1.5 px-2 py-1 border border-white/20 bg-white/5 text-white hover:bg-white/10 transition-colors disabled:opacity-50 flex-shrink-0 rounded-sm"
                >
                  {operationState.isRefreshing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  <span className="text-xs font-mono">Refresh</span>
                </button>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="flex items-center gap-1 border border-white/20 bg-white/10 px-2 py-1 text-xs font-mono text-white whitespace-nowrap">
                  <BarChart3 className="h-3 w-3 flex-shrink-0" />
                  {voices.reduce((sum, v) => sum + v.usageCount, 0)} uses
                </span>
                <span
                  className={cn(
                    "border px-2 py-1 text-xs font-mono whitespace-nowrap",
                    professionalVoicesRemaining === 0
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                      : "border-white/20 bg-white/10 text-white",
                  )}
                  title="Professional voice slots (ElevenLabs limitation)"
                >
                  Pro: {professionalVoiceCount}/1
                </span>
              </div>
            </div>
          </div>

          <div className="relative z-10 border-t border-white/10 shrink-0 my-4" />

          <div className="relative z-10 flex-1 p-0 overflow-hidden">
            {voices.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-12 px-6 text-center">
                <div className="rounded-full bg-[#FF580020] border border-[#FF5800]/40 p-6 mb-4">
                  <Mic className="h-10 w-10 text-[#FF5800]" />
                </div>
                <h3 className="text-lg font-semibold mb-2 text-white">No voices yet</h3>
                <p className="text-sm text-white/60 max-w-sm">
                  Create your first voice clone using the form on the left. Upload audio or record
                  your voice to get started.
                </p>
              </div>
            ) : (
              <ScrollArea className="h-full">
                <div className="p-6 space-y-6 pb-12">
                  {/* All Voices (processing status shown via badge) */}
                  {voices.map((voice) => {
                    const now = new Date();
                    return (
                      <BrandCard
                        key={voice.id}
                        corners={false}
                        hover
                        className={`cursor-pointer transition-all ${
                          selectedVoice?.id === voice.id
                            ? "border-[#FF5800] ring-2 ring-[#FF5800]/40"
                            : ""
                        }`}
                        onClick={() => setSelectedVoice(voice)}
                      >
                        <div className="pb-3">
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <h4 className="text-base truncate font-bold text-white">
                                {voice.name}
                              </h4>
                              <p className="line-clamp-1 text-xs text-white/60 mt-1">
                                {voice.description || "No description"}
                              </p>
                            </div>
                            <div className="ml-2 shrink-0">
                              <VoiceStatusBadge voice={voice} />
                            </div>
                          </div>
                        </div>

                        <div className="pb-3 space-y-3">
                          {/* Stats */}
                          <div className="grid grid-cols-3 gap-2 text-xs">
                            <div className="flex flex-col">
                              <span className="text-white/50 uppercase tracking-wide">Uses</span>
                              <span className="font-medium text-white">{voice.usageCount}</span>
                            </div>
                            <div className="flex flex-col">
                              <span className="text-white/50 uppercase tracking-wide">Samples</span>
                              <span className="font-medium text-white">{voice.sampleCount}</span>
                            </div>
                            {voice.audioQualityScore && (
                              <div className="flex flex-col">
                                <span className="text-white/50 uppercase tracking-wide">
                                  Quality
                                </span>
                                <span className="font-medium text-white">
                                  {voice.audioQualityScore}/10
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Metadata & Status */}
                          <div className="pt-2 border-t border-white/10 space-y-2">
                            {/* Processing Status Message */}
                            {(() => {
                              const mins = Math.max(
                                0,
                                (now.getTime() - new Date(voice.createdAt).getTime()) / 1000 / 60,
                              );
                              const isProcessing = voice.cloneType === "professional" && mins < 60;

                              if (isProcessing) {
                                let message = "";
                                if (mins < 30) {
                                  message =
                                    "Processing... Professional voices typically take 30-60 minutes.";
                                } else {
                                  message = "Finalizing... Click Refresh to check if ready.";
                                }

                                return (
                                  <Alert
                                    variant="default"
                                    className="py-2 rounded-none border-blue-500/40 bg-blue-500/10"
                                  >
                                    <AlertCircle className="h-3 w-3 text-blue-400" />
                                    <AlertDescription className="text-xs text-blue-400">
                                      {message}
                                    </AlertDescription>
                                  </Alert>
                                );
                              }
                              return null;
                            })()}
                          </div>

                          {/* Actions */}
                          <div className="flex gap-2 pt-2 border-t border-white/10">
                            {(() => {
                              const mins = Math.max(
                                0,
                                (now.getTime() - new Date(voice.createdAt).getTime()) / 1000 / 60,
                              );
                              const isProcessing = voice.cloneType === "professional" && mins < 60;

                              return (
                                <>
                                  <BrandButton
                                    variant="outline"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handlePreview(voice);
                                    }}
                                    disabled={isProcessing}
                                    className="flex-1 h-8 text-xs"
                                    title={
                                      isProcessing
                                        ? getEstimatedReadyMessage(voice)
                                        : "Preview voice"
                                    }
                                  >
                                    <Play className="mr-1 h-3 w-3" />
                                    Preview
                                  </BrandButton>
                                  <BrandButton
                                    variant="primary"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleUseInTTS(voice);
                                    }}
                                    disabled={isProcessing}
                                    className="flex-1 h-8 text-xs"
                                    title={
                                      isProcessing ? "Voice not ready yet" : "Use in text-to-speech"
                                    }
                                  >
                                    <ExternalLink className="mr-1 h-3 w-3" />
                                    Use in TTS
                                  </BrandButton>
                                  <BrandButton
                                    variant="ghost"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      updateOperation({
                                        deleteDialogVoice: voice,
                                      });
                                    }}
                                    className="h-8 px-2 text-rose-400 hover:text-rose-400 hover:bg-rose-500/10"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </BrandButton>
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      </BrandCard>
                    );
                  })}

                  {/* Voice Insights - Scrollable with the voices */}
                  {selectedVoice && (
                    <>
                      <div className="my-6 border-t border-white/10" />
                      <div className="pb-4">
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-white/50 mb-3">
                          <Sparkles className="h-4 w-4 text-[#FF5800]" />
                          Voice Insights
                        </div>
                        <div className="grid gap-3 rounded-none bg-black/40 border border-white/10 p-4 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/50">Clone Type</span>
                            <span className="font-medium capitalize text-white">
                              {selectedVoice.cloneType}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/50">Voice ID</span>
                            <span
                              className="font-mono text-xs truncate max-w-[180px] text-white"
                              title={selectedVoice.elevenlabsVoiceId}
                            >
                              {selectedVoice.elevenlabsVoiceId}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/50">Usage Count</span>
                            <span className="font-medium text-white">
                              {selectedVoice.usageCount} times
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/50">Sample Files</span>
                            <span className="font-medium text-white">
                              {selectedVoice.sampleCount} files
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/50">Total Duration</span>
                            <span className="font-medium text-white">
                              {formatDuration(selectedVoice.totalAudioDurationSeconds ?? null)}
                            </span>
                          </div>
                          {selectedVoice.audioQualityScore && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-white/50">Quality Score</span>
                              <span className="font-medium text-white">
                                {selectedVoice.audioQualityScore}/10
                              </span>
                            </div>
                          )}
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-white/50">Created</span>
                            <span className="font-medium text-white">
                              {formatDistanceToNow(new Date(selectedVoice.createdAt), {
                                addSuffix: true,
                              })}
                            </span>
                          </div>
                          {selectedVoice.lastUsedAt && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-white/50">Last Used</span>
                              <span className="font-medium text-white">
                                {formatDistanceToNow(new Date(selectedVoice.lastUsedAt), {
                                  addSuffix: true,
                                })}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </ScrollArea>
            )}
          </div>
        </BrandCard>
      </TabsContent>

      {/* Preview Dialog */}
      <Dialog
        open={!!previewState.voice}
        onOpenChange={() => {
          if (previewState.audioUrl) {
            URL.revokeObjectURL(previewState.audioUrl);
          }
          updatePreview({ voice: null, audioUrl: null });
        }}
      >
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{previewState.voice?.name}</DialogTitle>
            <DialogDescription>
              {previewState.voice?.description || "Voice preview"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {previewState.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
              </div>
            ) : previewState.audioUrl ? (
              <div className="p-4 rounded-none bg-black/40 border border-white/10">
                <p className="text-sm text-white/60 mb-3">
                  Preview Text: &ldquo;Hello! This is a preview of your custom voice clone.&rdquo;
                </p>
                <VoiceAudioPlayer audioUrl={previewState.audioUrl} />
              </div>
            ) : (
              <div className="text-center text-white/60 py-8">Failed to load audio preview</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!operationState.deleteDialogVoice}
        onOpenChange={() => updateOperation({ deleteDialogVoice: null })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Voice Clone?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;
              {operationState.deleteDialogVoice?.name}&rdquo;? This action cannot be undone and the
              voice will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={operationState.isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                operationState.deleteDialogVoice && handleDelete(operationState.deleteDialogVoice)
              }
              disabled={operationState.isDeleting}
              className="bg-destructive hover:bg-destructive/90"
            >
              {operationState.isDeleting ? "Deleting..." : "Delete Voice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}
