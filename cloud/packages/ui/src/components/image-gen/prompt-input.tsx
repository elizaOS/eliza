/**
 * Prompt input component for image generation with advanced options.
 * Supports prompt input, number of images, aspect ratio, and style preset selection.
 *
 * @param props - Prompt input configuration
 * @param props.prompt - Current prompt text
 * @param props.onPromptChange - Callback when prompt changes
 * @param props.onSubmit - Callback when form is submitted
 * @param props.isLoading - Whether generation is in progress
 * @param props.numImages - Number of images to generate
 * @param props.onNumImagesChange - Callback when number of images changes
 * @param props.aspectRatio - Selected aspect ratio
 * @param props.onAspectRatioChange - Callback when aspect ratio changes
 * @param props.stylePreset - Selected style preset
 * @param props.onStylePresetChange - Callback when style preset changes
 */

"use client";

import { Image as ImageIcon, Loader2, Palette, Ratio, Sparkles, Wand2 } from "lucide-react";
import { Button } from "../button";
import { Label } from "../label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select";

export type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "21:9" | "9:21";
export type StylePreset =
  | "none"
  | "photographic"
  | "digital-art"
  | "comic-book"
  | "fantasy-art"
  | "analog-film"
  | "neon-punk"
  | "isometric"
  | "low-poly"
  | "origami"
  | "line-art"
  | "cinematic"
  | "3d-model";

interface PromptInputProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  isLoading: boolean;
  numImages: number;
  onNumImagesChange: (num: number) => void;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (ratio: AspectRatio) => void;
  stylePreset: StylePreset;
  onStylePresetChange: (preset: StylePreset) => void;
}

export function ImagePromptInput({
  prompt,
  onPromptChange,
  onSubmit,
  isLoading,
  numImages,
  onNumImagesChange,
  aspectRatio,
  onAspectRatioChange,
  stylePreset,
  onStylePresetChange,
}: PromptInputProps) {
  return (
    <div className="rounded-2xl border bg-gradient-to-br from-card to-muted/20 p-8 shadow-sm">
      <form onSubmit={onSubmit} className="space-y-6">
        {/* Image Options Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Number of Images */}
          <div className="space-y-2">
            <Label htmlFor="num-images" className="flex items-center gap-2 text-sm font-semibold">
              <ImageIcon className="h-4 w-4 text-primary" />
              Images
            </Label>
            <Select
              value={numImages.toString()}
              onValueChange={(value) => onNumImagesChange(parseInt(value))}
              disabled={isLoading}
            >
              <SelectTrigger id="num-images" className="w-full">
                <SelectValue placeholder="Select number" />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4].map((num) => (
                  <SelectItem key={num} value={num.toString()}>
                    {num} {num === 1 ? "Image" : "Images"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Aspect Ratio */}
          <div className="space-y-2">
            <Label htmlFor="aspect-ratio" className="flex items-center gap-2 text-sm font-semibold">
              <Ratio className="h-4 w-4 text-primary" />
              Ratio
            </Label>
            <Select
              value={aspectRatio}
              onValueChange={(value) => onAspectRatioChange(value as AspectRatio)}
              disabled={isLoading}
            >
              <SelectTrigger id="aspect-ratio" className="w-full">
                <SelectValue placeholder="Select ratio" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1:1">1:1 (Square)</SelectItem>
                <SelectItem value="16:9">16:9 (Landscape)</SelectItem>
                <SelectItem value="9:16">9:16 (Portrait)</SelectItem>
                <SelectItem value="4:3">4:3</SelectItem>
                <SelectItem value="3:4">3:4</SelectItem>
                <SelectItem value="21:9">21:9 (Ultra Wide)</SelectItem>
                <SelectItem value="9:21">9:21 (Ultra Tall)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Style Preset */}
          <div className="space-y-2">
            <Label htmlFor="style-preset" className="flex items-center gap-2 text-sm font-semibold">
              <Palette className="h-4 w-4 text-primary" />
              Style Preset
            </Label>
            <Select
              value={stylePreset}
              onValueChange={(value) => onStylePresetChange(value as StylePreset)}
              disabled={isLoading}
            >
              <SelectTrigger id="style-preset" className="w-full">
                <SelectValue placeholder="Select style" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="photographic">Photographic</SelectItem>
                <SelectItem value="digital-art">Digital Art</SelectItem>
                <SelectItem value="comic-book">Comic Book</SelectItem>
                <SelectItem value="fantasy-art">Fantasy Art</SelectItem>
                <SelectItem value="analog-film">Analog Film</SelectItem>
                <SelectItem value="neon-punk">Neon Punk</SelectItem>
                <SelectItem value="isometric">Isometric</SelectItem>
                <SelectItem value="low-poly">Low Poly</SelectItem>
                <SelectItem value="origami">Origami</SelectItem>
                <SelectItem value="line-art">Line Art</SelectItem>
                <SelectItem value="cinematic">Cinematic</SelectItem>
                <SelectItem value="3d-model">3D Model</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Prompt Input */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label htmlFor="prompt" className="flex items-center gap-2 text-sm font-semibold">
              <Wand2 className="h-4 w-4 text-primary" />
              Image Description
            </label>
          </div>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => onPromptChange(e.currentTarget.value)}
            placeholder="Describe the image you want to generate in detail... The more specific you are, the better the results!"
            disabled={isLoading}
            rows={6}
            className="w-full rounded-xl border-2 bg-background px-5 py-4 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed resize-none shadow-sm transition-all"
          />
        </div>

        <Button
          type="submit"
          disabled={isLoading || !prompt.trim()}
          className="w-full rounded-xl h-12 text-base font-medium shadow-md hover:shadow-lg transition-all"
          size="lg"
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Generating your masterpiece...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-5 w-5" />
              Generate Image
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
