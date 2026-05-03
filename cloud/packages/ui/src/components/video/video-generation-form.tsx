/**
 * Video generation form component with prompt input, model selection, and reference URL.
 * Displays model information, cost, and processing time estimates.
 *
 * @param props - Video generation form configuration
 * @param props.prompt - Video generation prompt
 * @param props.onPromptChange - Callback when prompt changes
 * @param props.selectedModel - Currently selected model ID
 * @param props.onModelChange - Callback when model changes
 * @param props.models - Available video models
 * @param props.referenceUrl - Optional reference image URL
 * @param props.onReferenceChange - Callback when reference URL changes
 * @param props.onGenerate - Callback when generate button is clicked
 * @param props.isSubmitting - Whether generation is in progress
 * @param props.errorMessage - Error message to display
 * @param props.statusMessage - Status message to display
 */

"use client";

import {
  BrandCard,
  CornerBrackets,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@elizaos/cloud-ui";
import { Loader2, Timer } from "lucide-react";
import { useMemo } from "react";
import type { VideoModelOption } from "./types";

interface VideoGenerationFormProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  selectedModel: string;
  onModelChange: (value: string) => void;
  models: VideoModelOption[];
  referenceUrl: string;
  onReferenceChange: (value: string) => void;
  onGenerate?: (payload: { prompt: string; model: string; referenceUrl?: string }) => void;
  isSubmitting?: boolean;
  errorMessage?: string | null;
  statusMessage?: string | null;
}

export function VideoGenerationForm({
  prompt,
  onPromptChange,
  selectedModel,
  onModelChange,
  models,
  onGenerate,
  referenceUrl,
  onReferenceChange,
  isSubmitting = false,
  errorMessage,
  statusMessage,
}: VideoGenerationFormProps) {
  const activeModel = useMemo(
    () => models.find((model) => model.id === selectedModel) ?? models[0],
    [models, selectedModel],
  );

  return (
    <BrandCard className="relative h-full">
      <CornerBrackets size="md" className="opacity-50" />

      <form
        className="relative z-10 flex h-full flex-col gap-4 md:gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          onGenerate?.({
            prompt,
            model: selectedModel,
            referenceUrl,
          });
        }}
      >
        <div className="pb-0 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
            <h3 className="text-base md:text-lg lg:text-xl font-mono font-bold text-[#e1e1e1] uppercase">
              Generate a video
            </h3>
          </div>
          {errorMessage ? (
            <p
              className="text-xs md:text-sm font-mono text-rose-400 bg-rose-500/10 border border-rose-500/40 p-2"
              role="alert"
            >
              {errorMessage}
            </p>
          ) : null}
        </div>

        <div className="space-y-4 md:space-y-5">
          <div className="space-y-2">
            <label
              htmlFor="video-prompt"
              className="text-xs font-mono font-medium text-white/70 uppercase tracking-wide"
            >
              Prompt
            </label>
            <Textarea
              id="video-prompt"
              placeholder="A cinematic drone shot over a futuristic coastal city at sunset"
              rows={4}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              className="min-h-[100px] md:min-h-[120px] resize-none border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-mono font-medium text-white/70 uppercase tracking-wide">
              Model preset
            </label>
            <Select value={selectedModel} onValueChange={onModelChange}>
              <SelectTrigger className="w-full border-white/10 bg-black/40 text-white focus:ring-1 focus:ring-[#FF5800] h-auto min-h-[60px]">
                <SelectValue placeholder="Select a model">
                  {activeModel && (
                    <div className="flex flex-col gap-1 py-1 text-left min-w-0 w-full pr-6">
                      <span className="text-xs md:text-sm font-mono font-medium text-white truncate">
                        {activeModel.label}
                      </span>
                      <span className="text-xs font-mono text-white/60 leading-relaxed line-clamp-2">
                        {activeModel.description}
                      </span>
                    </div>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-black/90 max-w-[90vw] sm:max-w-md">
                {models.map((model) => (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    className="text-white hover:bg-white/10 focus:bg-white/10 py-3"
                  >
                    <div className="flex flex-col gap-1.5 py-1 max-w-full">
                      <span className="text-xs md:text-sm font-mono font-medium text-white">
                        {model.label}
                      </span>
                      <span className="text-xs font-mono text-white/60 leading-relaxed">
                        {model.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-4 text-xs font-mono text-white/50 border-t border-white/5 pt-3">
            <span>{activeModel.dimensions}</span>
            <span className="flex items-center gap-1">
              <Timer className="h-3 w-3" />
              {activeModel.durationEstimate}
            </span>
          </div>

          <div className="grid gap-2">
            <label
              htmlFor="video-reference"
              className="text-xs font-mono font-medium text-white/70 uppercase tracking-wide"
            >
              Reference image (optional)
            </label>
            <Input
              id="video-reference"
              type="url"
              placeholder="https://..."
              className="border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
              value={referenceUrl}
              onChange={(event) => onReferenceChange(event.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-white/10 pt-3 md:pt-4">
          <button
            type="submit"
            disabled={isSubmitting}
            className="relative bg-[#e1e1e1] px-4 py-3 overflow-hidden hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-full"
          >
            <div
              className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
              style={{
                backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                backgroundSize: "2.915576934814453px 2.915576934814453px",
              }}
            />
            <span className="relative z-10 text-black font-mono font-medium text-sm md:text-base flex items-center justify-center gap-2">
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating…
                </>
              ) : (
                "Generate video"
              )}
            </span>
          </button>
          <div className="space-y-1 text-center text-xs font-mono text-white/50" aria-live="polite">
            {statusMessage ? <p className="text-white/80">{statusMessage}</p> : null}
          </div>
        </div>
      </form>
    </BrandCard>
  );
}
