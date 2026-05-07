/**
 * Voice manager component for creating, previewing, and managing voice clones.
 * Supports voice creation, deletion, preview playback, and credit balance management.
 *
 * @param props - Voice manager configuration
 * @param props.voices - Array of voice objects to manage
 * @param props.onVoicesChange - Callback when voices array changes
 * @param props.creditBalance - Current credit balance
 * @param props.onCreditBalanceChange - Callback when credit balance changes
 */

"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@elizaos/cloud-ui";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { VoiceAudioPlayer, VoiceEmptyState } from "@elizaos/cloud-ui/components/voice";
import type { Voice } from "@elizaos/cloud-ui/components/voice/types";
import { VoiceCard } from "./voice-card";
import { VoiceCloneForm } from "./voice-clone-form";

interface VoiceManagerProps {
  voices: Voice[];
  onVoicesChange: (voices: Voice[]) => void;
  creditBalance: number;
  onCreditBalanceChange: (balance: number) => void;
}

interface PreviewState {
  voice: Voice | null;
  audioUrl: string | null;
  isLoading: boolean;
}

export function VoiceManager({
  voices,
  onVoicesChange,
  creditBalance,
  onCreditBalanceChange,
}: VoiceManagerProps) {
  const [isFormExpanded, setIsFormExpanded] = useState(false); // Default collapsed
  const [previewState, setPreviewState] = useState<PreviewState>({
    voice: null,
    audioUrl: null,
    isLoading: false,
  });

  const updatePreview = (updates: Partial<PreviewState>) => {
    setPreviewState((prev) => ({ ...prev, ...updates }));
  };

  const handleVoiceCreated = (newVoice: Voice) => {
    onVoicesChange([newVoice, ...voices]);
    setIsFormExpanded(false); // Collapse form after creation
    toast.success(`Voice "${newVoice.name}" created successfully!`);

    // Scroll to top to show the new voice
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleVoiceDeleted = (voiceId: string) => {
    onVoicesChange(voices.filter((v) => v.id !== voiceId));
  };

  const handlePreview = async (voice: Voice) => {
    updatePreview({ voice, isLoading: true });

    // Generate a sample text-to-speech to preview the voice
    const response = await fetch("/api/elevenlabs/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "Hello! This is a preview of your custom voice clone.",
        voiceId: voice.elevenlabsVoiceId,
      }),
    });

    if (!response.ok) {
      updatePreview({ isLoading: false });
      throw new Error("Failed to generate preview");
    }

    // Convert audio stream to blob URL
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    updatePreview({ audioUrl: url, isLoading: false });
  };

  const handleClosePreview = () => {
    if (previewState.audioUrl) {
      URL.revokeObjectURL(previewState.audioUrl);
    }
    updatePreview({ voice: null, audioUrl: null });
  };

  return (
    <div className="space-y-6">
      {/* Voice List - Always show first */}
      {voices.length === 0 ? (
        <VoiceEmptyState onCreateClick={() => setIsFormExpanded(true)} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-semibold">My Voices</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {voices.length} custom voice{voices.length !== 1 ? "s" : ""} • Use them in
                text-to-speech generation
              </p>
            </div>
            <Button onClick={() => setIsFormExpanded(!isFormExpanded)} size="lg">
              {isFormExpanded ? (
                <>
                  <ChevronUp className="mr-2 h-4 w-4" />
                  Cancel
                </>
              ) : (
                <>
                  <ChevronDown className="mr-2 h-4 w-4" />
                  Create New Voice
                </>
              )}
            </Button>
          </div>

          {/* Voice Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {voices.map((voice) => (
              <VoiceCard
                key={voice.id}
                voice={voice}
                onDelete={handleVoiceDeleted}
                onPreview={handlePreview}
              />
            ))}
          </div>
        </div>
      )}

      {/* Voice Clone Form - Collapsible */}
      {(isFormExpanded || voices.length === 0) && (
        <div className="space-y-4">
          {voices.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-sm text-muted-foreground">Create New Voice</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}

          <VoiceCloneForm
            creditBalance={creditBalance}
            onSuccess={handleVoiceCreated}
            onCreditBalanceChange={onCreditBalanceChange}
          />
        </div>
      )}

      {/* Preview Dialog */}
      <Dialog open={!!previewState.voice} onOpenChange={handleClosePreview}>
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
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : previewState.audioUrl ? (
              <div className="p-4 rounded-lg bg-muted">
                <p className="text-sm text-muted-foreground mb-3">
                  Preview Text: &quot;Hello! This is a preview of your custom voice clone.&quot;
                </p>
                <VoiceAudioPlayer audioUrl={previewState.audioUrl} />
              </div>
            ) : (
              <div className="text-center text-muted-foreground py-8">
                Failed to load audio preview
              </div>
            )}

            {previewState.voice && (
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Clone Type</p>
                  <p className="font-medium capitalize">{previewState.voice.cloneType}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Samples</p>
                  <p className="font-medium">{previewState.voice.sampleCount} files</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Times Used</p>
                  <p className="font-medium">{previewState.voice.usageCount}</p>
                </div>
                {previewState.voice.audioQualityScore && (
                  <div>
                    <p className="text-muted-foreground">Quality Score</p>
                    <p className="font-medium">{previewState.voice.audioQualityScore}/10</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
