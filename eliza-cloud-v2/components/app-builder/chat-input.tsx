"use client";

/**
 * Optimized Chat Input Component with Speech-to-Text and Image Upload
 *
 * Features:
 * - Zustand for isolated input state management
 * - ElevenLabs STT integration for voice input
 * - Image upload with preview and LLM vision support
 * - Beautiful audio visualization during recording
 * - Production-ready AAA UI
 */

import { memo, useCallback, useRef, useEffect, useState } from "react";
import { Loader2, ArrowUp, Mic, Square, X, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatInput, useModelSelection, type ImageAttachment } from "@/lib/app-builder/store";
import { useAppBuilderSTT } from "./use-app-builder-stt";
import { cn } from "@/lib/utils";
import { ModelSelector } from "./model-selector";
import Image from "next/image";

type SessionStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "generating"
  | "error"
  | "stopped"
  | "timeout"
  | "not_configured"
  | "recovering";

interface ChatInputProps {
  onSendPrompt: (text?: string, images?: ImageAttachment[]) => void;
  onStopGeneration?: () => void;
  status: SessionStatus;
}

// Deterministic pseudo-random values for each bar (seeded by index)
const barRandomFactors = [0.85, 0.72, 0.93, 0.68, 0.79];

// Audio waveform visualization component
const AudioWaveform = memo(function AudioWaveform({
  audioLevel,
  isRecording,
}: {
  audioLevel: number;
  isRecording: boolean;
}) {
  const bars = 5;

  return (
    <div className="flex items-center justify-center gap-[3px] h-5">
      {Array.from({ length: bars }).map((_, i) => {
        // Create a wave effect with varying heights based on position and audio level
        const baseHeight = 0.3;
        const waveOffset = Math.sin((i / bars) * Math.PI) * 0.4;
        // Use deterministic "random" factor based on bar index
        const randomFactor = barRandomFactors[i] ?? 0.8;
        const height = isRecording
          ? Math.max(
              baseHeight,
              (audioLevel * 0.7 + waveOffset) * (0.6 + randomFactor * 0.4),
            )
          : baseHeight;

        return (
          <div
            key={i}
            className="w-[3px] rounded-full bg-gradient-to-t from-white/60 to-white/80 transition-all duration-75"
            style={{
              height: `${Math.max(4, height * 20)}px`,
              opacity: isRecording ? 0.9 : 0.4,
            }}
          />
        );
      })}
    </div>
  );
});

// Recording timer display
const RecordingTimer = memo(function RecordingTimer({
  seconds,
}: {
  seconds: number;
}) {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return (
    <span className="text-[11px] font-mono text-white/70 tabular-nums">
      {minutes.toString().padStart(2, "0")}:{secs.toString().padStart(2, "0")}
    </span>
  );
});

// Image preview component for attached images
const ImagePreview = memo(function ImagePreview({
  images,
  onRemove,
  disabled,
}: {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  if (images.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {images.map((img) => (
        <div
          key={img.id}
          className={cn(
            "relative group rounded-lg overflow-hidden border bg-white/[0.04]",
            img.uploadStatus === 'error' ? "border-red-500/50" : "border-white/[0.1]"
          )}
        >
          <Image
            src={img.previewUrl}
            alt="Attached image"
            width={64}
            height={64}
            className="w-16 h-16 object-cover"
          />
          {!disabled && (
            <button
              type="button"
              onClick={() => onRemove(img.id)}
              className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500/90 hover:bg-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
            >
              <X className="h-3 w-3 text-white" />
            </button>
          )}
          {/* Loading/uploading indicator */}
          {(img.uploadStatus === 'pending' || img.uploadStatus === 'uploading') && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-white/70" />
            </div>
          )}
          {/* Upload success indicator */}
          {img.uploadStatus === 'uploaded' && (
            <div className="absolute bottom-1 right-1 h-4 w-4 rounded-full bg-green-500 flex items-center justify-center">
              <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          )}
          {/* Upload error indicator */}
          {img.uploadStatus === 'error' && (
            <div className="absolute inset-0 bg-red-500/30 flex items-center justify-center">
              <span className="text-[9px] text-red-300 px-1">Error</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
});

// Image upload button
const ImageUploadButton = memo(function ImageUploadButton({
  onSelectImages,
  disabled,
  imageCount,
}: {
  onSelectImages: (files: FileList) => void;
  disabled: boolean;
  imageCount: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        onSelectImages(files);
        // Reset input so same file can be selected again
        e.target.value = "";
      }
    },
    [onSelectImages],
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleChange}
        className="hidden"
      />
      <Button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        size="icon"
        className={cn(
          "h-8 w-8 xl:h-7 xl:w-7 rounded-xl transition-all touch-manipulation relative",
          "bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-30",
          "border border-white/[0.06] hover:border-white/[0.1]",
          "group",
          imageCount > 0 && "border-[#FF5800]/40 bg-[#FF5800]/10",
        )}
        title="Attach images"
      >
        <ImageIcon className={cn(
          "h-4 w-4 xl:h-3.5 xl:w-3.5 transition-colors",
          imageCount > 0 ? "text-[#FF5800]" : "text-white/50 group-hover:text-white/70"
        )} />
        {imageCount > 0 && (
          <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-[#FF5800] text-[10px] font-medium text-white flex items-center justify-center">
            {imageCount}
          </span>
        )}
      </Button>
    </>
  );
});

// Mic button with recording state
const MicButton = memo(function MicButton({
  isRecording,
  isProcessing,
  isSupported,
  audioLevel,
  recordingTime,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  disabled,
}: {
  isRecording: boolean;
  isProcessing: boolean;
  isSupported: boolean;
  audioLevel: number;
  recordingTime: number;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  disabled: boolean;
}) {
  if (!isSupported) {
    return null;
  }

  // Processing state - show spinner
  if (isProcessing) {
    return (
      <div className="h-8 w-8 xl:h-7 xl:w-7 rounded-xl bg-[#FF5800] flex items-center justify-center">
        <Loader2 className="h-4 w-4 xl:h-3.5 xl:w-3.5 animate-spin text-white" />
      </div>
    );
  }

  // Recording state - show waveform, timer, stop/cancel buttons
  if (isRecording) {
    return (
      <div className="flex items-center gap-2">
        {/* Recording indicator */}
        <div className="flex items-center gap-2 px-2 h-8 xl:h-7 rounded-xl bg-white/[0.08] border border-white/[0.15]">
          {/* Pulsing dot */}
          <div className="relative">
            <div className="h-2 w-2 rounded-full bg-white/80" />
            <div className="absolute inset-0 h-2 w-2 rounded-full bg-white/80 animate-ping opacity-75" />
          </div>

          {/* Waveform visualization */}
          <AudioWaveform audioLevel={audioLevel} isRecording={isRecording} />

          {/* Timer */}
          <RecordingTimer seconds={recordingTime} />
        </div>

        {/* Cancel button */}
        <Button
          type="button"
          onClick={onCancelRecording}
          size="icon"
          variant="ghost"
          className="h-8 w-8 xl:h-7 xl:w-7 rounded-xl text-white/40 hover:text-white/60 hover:bg-white/[0.04]"
          title="Cancel recording"
        >
          <X className="h-3.5 w-3.5" />
        </Button>

        {/* Stop/Send button */}
        <Button
          type="button"
          onClick={onStopRecording}
          size="icon"
          className="h-8 w-8 xl:h-7 xl:w-7 rounded-xl bg-red-600/40 hover:bg-red-600/50 border border-red-500/40 text-red-400 transition-all"
          title="Stop recording"
        >
          <Square className="h-3.5 w-3.5 xl:h-3 xl:w-3 fill-current" />
        </Button>
      </div>
    );
  }

  // Default state - mic button
  return (
    <Button
      type="button"
      onClick={onStartRecording}
      disabled={disabled}
      size="icon"
      className={cn(
        "h-8 w-8 xl:h-7 xl:w-7 rounded-xl transition-all touch-manipulation",
        "bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-30",
        "border border-white/[0.06] hover:border-white/[0.1]",
        "group",
      )}
      title="Start voice input"
    >
      <Mic className="h-4 w-4 xl:h-3.5 xl:w-3.5 text-white/50 group-hover:text-white/70 transition-colors" />
    </Button>
  );
});

// Completely isolated input component - only subscribes to input state
const ChatInputInner = memo(function ChatInputInner({
  onSendPrompt,
  onStopGeneration,
  status,
}: ChatInputProps) {
  const input = useChatInput((state) => state.input);
  const setInput = useChatInput((state) => state.setInput);
  const images = useChatInput((state) => state.images);
  const addImage = useChatInput((state) => state.addImage);
  const removeImage = useChatInput((state) => state.removeImage);
  const setImageBase64 = useChatInput((state) => state.setImageBase64);
  const setImageBlobUrl = useChatInput((state) => state.setImageBlobUrl);
  const setImageUploadStatus = useChatInput((state) => state.setImageUploadStatus);
  const selectedModel = useModelSelection((state) => state.selectedModel);
  const setSelectedModel = useModelSelection((state) => state.setSelectedModel);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // STT hook
  const stt = useAppBuilderSTT();

  // Convert file to base64
  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Extract base64 data (remove data:image/xxx;base64, prefix)
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  // Upload image to Vercel Blob storage
  const uploadToBlob = useCallback(async (id: string, base64: string, filename: string) => {
    try {
      setImageUploadStatus(id, 'uploading');
      
      const response = await fetch('/api/v1/app-builder/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: [{ base64: `data:image/png;base64,${base64}`, filename }]
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to upload image');
      }

      const data = await response.json();
      if (data.success && data.images[0]?.success) {
        setImageBlobUrl(id, data.images[0].url);
      } else {
        throw new Error(data.images[0]?.error || 'Upload failed');
      }
    } catch (error) {
      console.error("Failed to upload image to blob storage:", error);
      setImageUploadStatus(id, 'error', error instanceof Error ? error.message : 'Upload failed');
    }
  }, [setImageBlobUrl, setImageUploadStatus]);

  // Handle image selection
  const handleSelectImages = useCallback(
    async (files: FileList) => {
      const maxImages = 5;
      const currentCount = images.length;
      const availableSlots = maxImages - currentCount;

      if (availableSlots <= 0) {
        return; // Max images reached
      }

      const filesToAdd = Array.from(files).slice(0, availableSlots);

      for (const file of filesToAdd) {
        // Validate file type
        if (!file.type.startsWith("image/")) {
          continue;
        }

        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
          continue;
        }

        const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const previewUrl = URL.createObjectURL(file);

        // Add image with preview URL immediately (pending upload)
        addImage({ id, file, previewUrl, uploadStatus: 'pending' });

        // Convert to base64 and upload to blob storage
        try {
          const base64 = await fileToBase64(file);
          setImageBase64(id, base64);
          
          // Upload to Vercel Blob for persistent storage
          uploadToBlob(id, base64, file.name);
        } catch (error) {
          console.error("Failed to process image:", error);
          removeImage(id);
        }
      }
    },
    [images.length, addImage, removeImage, setImageBase64, fileToBase64, uploadToBlob],
  );

  // Cleanup preview URLs when component unmounts
  useEffect(() => {
    return () => {
      images.forEach((img) => {
        URL.revokeObjectURL(img.previewUrl);
      });
    };
  }, [images]);

  // Auto-resize textarea
  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "44px";
      textarea.style.height = Math.min(textarea.scrollHeight, 100) + "px";
    }
  }, []);

  // Handle input change - direct Zustand update, no parent re-render
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
    },
    [setInput],
  );

  // Handle key down
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const hasContent = input.trim() || images.length > 0;
        const allImagesReady = images.every((img) => img.base64);
        if (status === "ready" && hasContent && allImagesReady) {
          onSendPrompt(undefined, images.length > 0 ? images : undefined);
        }
      }
    },
    [status, input, images, onSendPrompt],
  );

  // Handle send button click
  const handleSend = useCallback(() => {
    const hasContent = input.trim() || images.length > 0;
    const allImagesReady = images.every((img) => img.base64);
    if (hasContent && status === "ready" && allImagesReady) {
      onSendPrompt(undefined, images.length > 0 ? images : undefined);
    }
  }, [input, images, status, onSendPrompt]);

  // Handle STT start
  const handleStartRecording = useCallback(async () => {
    await stt.startRecording();
  }, [stt]);

  // Handle STT stop - transcribe and populate input
  const handleStopRecording = useCallback(async () => {
    const transcript = await stt.stopRecording();
    if (transcript) {
      // Set the transcribed text as input
      setInput(transcript);
      // Focus the textarea
      textareaRef.current?.focus();
      // Auto-resize after setting content
      setTimeout(handleInput, 0);
    }
  }, [stt, setInput, handleInput]);

  // Handle STT cancel
  const handleCancelRecording = useCallback(() => {
    stt.cancelRecording();
  }, [stt]);

  // Determine if controls should be disabled
  const isDisabled = status !== "ready" || stt.isRecording || stt.isProcessing;
  const isMicDisabled = status !== "ready" && status !== "idle";
  const hasContent = input.trim() || images.length > 0;
  const allImagesReady = images.every((img) => img.base64 && (img.blobUrl || img.uploadStatus === 'uploading'));
  const allImagesUploaded = images.every((img) => img.blobUrl);
  const canSend = hasContent && allImagesReady && (images.length === 0 || allImagesUploaded);

  return (
    <div className="flex-shrink-0 p-2 xl:p-4 border-t border-white/[0.04] bg-[#0a0a0b]">
      {/* Visor Scanner Animation Styles */}
      <style jsx global>{`
        @keyframes visor-scan {
          0% {
            left: -100px;
          }
          100% {
            left: calc(100% + 100px);
          }
        }
        @keyframes pulse-ring {
          0% {
            transform: scale(0.8);
            opacity: 0.8;
          }
          100% {
            transform: scale(1.4);
            opacity: 0;
          }
        }
      `}</style>

      <div
        className={cn(
          "relative rounded-2xl border bg-white/[0.04] overflow-hidden transition-all shadow-lg shadow-black/20",
          stt.isRecording
            ? "border-white/[0.25] bg-white/[0.08]"
            : "border-white/[0.08] focus-within:border-white/[0.12] focus-within:bg-white/[0.05]",
        )}
      >
        {/* Subtle scanning animation for generating state */}
        {status === "generating" && (
          <div className="absolute top-0 left-0 right-0 h-[1px] overflow-hidden pointer-events-none z-10 bg-white/[0.03]">
            <div
              className="absolute h-full w-32 bg-gradient-to-r from-transparent via-[#FF5800]/60 to-transparent"
              style={{
                animation: "visor-scan 3s ease-in-out infinite",
              }}
            />
          </div>
        )}

        {/* Image previews */}
        <ImagePreview
          images={images}
          onRemove={removeImage}
          disabled={isDisabled}
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          rows={1}
          placeholder={
            stt.isRecording
              ? "Listening..."
              : stt.isProcessing
                ? "Processing speech..."
                : images.length > 0
                  ? "Describe what to do with these images..."
                  : "Describe what you want to build..."
          }
          disabled={isDisabled}
          className={cn(
            "w-full bg-transparent px-3 xl:px-4 pt-2.5 xl:pt-3 pb-2 text-[13px] xl:text-[14px] text-white/90 placeholder:text-white/30 focus:outline-none disabled:opacity-50 resize-none leading-relaxed",
            stt.isRecording &&
              "placeholder:text-white/70 placeholder:animate-pulse",
          )}
          style={{ minHeight: "44px", maxHeight: "100px" }}
        />

        {/* Bottom bar with model selector, image upload, mic, and send buttons */}
        <div className="flex items-center justify-between px-2 pb-2">
          {/* Left side - model selector (desktop) or status (mobile) */}
          <div className="flex items-center gap-1.5">
            {/* Model selector - visible on desktop */}
            <div className="hidden xl:block">
              <ModelSelector
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                disabled={status === "generating"}
                compact
              />
            </div>
            {/* Status indicator - visible on mobile/tablet only */}
            <div className="xl:hidden">
              {status === "generating" && !stt.isRecording && (
                <span className="text-[10px] text-[#FF5800]/70 flex items-center gap-1">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  Building...
                </span>
              )}
              {status === "recovering" && (
                <span className="text-[10px] text-[#FF5800]/70 flex items-center gap-1">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  Reconnecting...
                </span>
              )}
            </div>
          </div>

          {/* Right side - image upload, mic and send buttons */}
          <div className="flex items-center gap-2">
            {/* Image upload button - hidden during recording */}
            {!stt.isRecording && !stt.isProcessing && (
              <ImageUploadButton
                onSelectImages={handleSelectImages}
                disabled={isDisabled || images.length >= 5}
                imageCount={images.length}
              />
            )}

            {/* Mic button with STT functionality */}
            <MicButton
              isRecording={stt.isRecording}
              isProcessing={stt.isProcessing}
              isSupported={stt.isSupported}
              audioLevel={stt.audioLevel}
              recordingTime={stt.recordingTime}
              onStartRecording={handleStartRecording}
              onStopRecording={handleStopRecording}
              onCancelRecording={handleCancelRecording}
              disabled={isMicDisabled}
            />

            {/* Send/Stop button - hidden during recording */}
            {!stt.isRecording &&
              !stt.isProcessing &&
              (status === "generating" && onStopGeneration ? (
                <Button
                  type="button"
                  onClick={onStopGeneration}
                  size="icon"
                  className="h-8 w-8 xl:h-7 xl:w-7 rounded-xl bg-red-600/40 hover:bg-red-600/50 border border-red-500/40 text-red-400 transition-all touch-manipulation animate-pulse"
                  title="Stop generation"
                >
                  <Square className="h-3.5 w-3.5 xl:h-3 xl:w-3 fill-current" />
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSend || status !== "ready"}
                  size="icon"
                  className="h-8 w-8 xl:h-7 xl:w-7 rounded-xl bg-[#FF5800] hover:bg-[#e54e00] disabled:bg-white/10 transition-all touch-manipulation group"
                >
                  <ArrowUp className="h-4 w-4 xl:h-3.5 xl:w-3.5 text-white group-disabled:text-neutral-400" />
                </Button>
              ))}
          </div>
        </div>
      </div>

      {/* STT error display */}
      {stt.error && (
        <div className="mt-2 px-3 py-1.5 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl">
          {stt.error}
        </div>
      )}
    </div>
  );
});

// Export with a stable reference
export const ChatInput = ChatInputInner;
