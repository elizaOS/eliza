/**
 * Image generator component with prompt input, aspect ratio, and style preset options.
 * Handles image generation state and displays generated images.
 */

"use client";

import {
  type AspectRatio,
  ImageEmptyState as EmptyState,
  ImageLoadingState as LoadingState,
  ImagePromptInput as PromptInput,
  type StylePreset,
} from "@elizaos/cloud-ui/components/image-gen";
import { useCallback, useState } from "react";
import { ImageDisplay } from "./image-display";

// Re-export types for consumers that still import from this file
export type { AspectRatio, StylePreset } from "@elizaos/cloud-ui/components/image-gen";

interface GeneratedImage {
  image: string;
  url?: string;
  text: string;
}

interface FormState {
  prompt: string;
  numImages: number;
  aspectRatio: AspectRatio;
  stylePreset: StylePreset;
}

interface GenerationState {
  images: GeneratedImage[];
  isLoading: boolean;
  error: string | null;
}

export function ImageGenerator() {
  const [formState, setFormState] = useState<FormState>({
    prompt: "",
    numImages: 1,
    aspectRatio: "1:1",
    stylePreset: "none",
  });

  const [generationState, setGenerationState] = useState<GenerationState>({
    images: [],
    isLoading: false,
    error: null,
  });

  const updateForm = (updates: Partial<FormState>) => {
    setFormState((prev) => ({ ...prev, ...updates }));
  };

  const updateGeneration = (updates: Partial<GenerationState>) => {
    setGenerationState((prev) => ({ ...prev, ...updates }));
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formState.prompt.trim()) return;

    updateGeneration({ isLoading: true, error: null });

    try {
      const response = await fetch("/api/v1/generate-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: formState.prompt,
          numImages: formState.numImages,
          aspectRatio: formState.aspectRatio,
          stylePreset: formState.stylePreset !== "none" ? formState.stylePreset : undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to generate image");
      }

      // Handle multiple images response
      if (data.images && Array.isArray(data.images)) {
        const processedImages = data.images.map((img: GeneratedImage) => ({
          image: img.image.startsWith("data:") ? img.image : `data:image/png;base64,${img.image}`,
          url: img.url,
          text: img.text || "",
        }));
        updateGeneration({ images: processedImages });
      }
    } catch (err) {
      updateGeneration({
        error: err instanceof Error ? err.message : "An error occurred",
      });
    } finally {
      updateGeneration({ isLoading: false });
    }
  };

  const handleDownload = useCallback((imageData: string, index: number) => {
    const link = document.createElement("a");
    link.href = imageData;
    const timestamp = Date.now();
    link.download = `eliza-generated-${timestamp}-${index + 1}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  const handleGenerateAnother = () => {
    updateGeneration({ images: [] });
  };

  return (
    <div className="space-y-8 w-full">
      <PromptInput
        prompt={formState.prompt}
        onPromptChange={(v: string) => updateForm({ prompt: v })}
        onSubmit={handleGenerate}
        isLoading={generationState.isLoading}
        numImages={formState.numImages}
        onNumImagesChange={(v: number) => updateForm({ numImages: v })}
        aspectRatio={formState.aspectRatio}
        onAspectRatioChange={(v: AspectRatio) => updateForm({ aspectRatio: v })}
        stylePreset={formState.stylePreset}
        onStylePresetChange={(v: StylePreset) => updateForm({ stylePreset: v })}
      />

      {generationState.error && (
        <div className="rounded-xl border-2 border-destructive bg-destructive/10 px-6 py-4 animate-in fade-in slide-in-from-top-4 duration-300">
          <p className="text-sm text-destructive font-medium">{generationState.error}</p>
        </div>
      )}

      {generationState.isLoading ? (
        <LoadingState />
      ) : generationState.images.length > 0 ? (
        <div className="space-y-6">
          <div
            className={`grid gap-6 ${generationState.images.length === 1 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}
          >
            {generationState.images.map((img, index) => (
              <ImageDisplay
                key={index}
                imageUrl={img.image}
                prompt={formState.prompt}
                generatedText={img.text}
                onDownload={() => handleDownload(img.image, index)}
                onGenerateAnother={handleGenerateAnother}
                showGenerateAnother={index === generationState.images.length - 1}
              />
            ))}
          </div>
        </div>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}
