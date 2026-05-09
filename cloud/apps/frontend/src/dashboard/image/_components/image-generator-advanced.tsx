/**
 * Advanced image generator component with full-featured controls.
 * Supports prompt input, advanced settings (width, height, steps, guidance scale),
 * image history, favorites, and carousel display of generated images.
 */

"use client";

import {
  BrandCard,
  Button,
  CornerBrackets,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Slider,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@elizaos/cloud-ui";
import { Image } from "@elizaos/cloud-ui";
import {
  ArrowUp,
  Check,
  Copy,
  Download,
  ImageIcon,
  ImagePlus,
  Loader2,
  RectangleHorizontal,
  RectangleVertical,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GalleryItem } from "@/lib/types/gallery";

async function listExploreImages(limit = 20): Promise<GalleryItem[]> {
  const res = await fetch(`/api/v1/gallery/explore?limit=${limit}`, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to load explore images (${res.status})`);
  }
  const data = (await res.json()) as {
    items: Array<{
      id: string;
      type: "image" | "video";
      url: string;
      thumbnailUrl?: string | null;
      prompt: string;
      model: string;
      status: string;
      createdAt: string;
      completedAt?: string | null;
      dimensions?: { width?: number; height?: number; duration?: number } | null;
      mimeType?: string | null;
      fileSize?: string | null;
    }>;
  };
  return data.items.map((it) => ({
    id: it.id,
    type: it.type,
    url: it.url,
    thumbnailUrl: it.thumbnailUrl ?? undefined,
    prompt: it.prompt,
    model: it.model,
    status: it.status,
    createdAt: new Date(it.createdAt),
    completedAt: it.completedAt ? new Date(it.completedAt) : undefined,
    dimensions: it.dimensions ?? undefined,
    mimeType: it.mimeType ?? undefined,
    fileSize: it.fileSize ? BigInt(it.fileSize) : undefined,
  }));
}

interface ImageGenerationSettings {
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
}

interface GeneratedImage {
  id: string;
  url: string;
  prompt: string;
  timestamp: Date;
  settings: ImageGenerationSettings;
}

interface ImageGeneratorAdvancedProps {
  initialHistory?: GalleryItem[];
}

const SIZE_PRESETS = [
  { label: "Square", width: 1024, height: 1024, icon: Square },
  { label: "Portrait", width: 768, height: 1024, icon: RectangleVertical },
  { label: "Landscape", width: 1024, height: 768, icon: RectangleHorizontal },
  { label: "Wide", width: 1280, height: 768, icon: RectangleHorizontal },
];

export function ImageGeneratorAdvanced({ initialHistory = [] }: ImageGeneratorAdvancedProps) {
  // Convert initial history to GeneratedImage format
  const convertedHistory: GeneratedImage[] = initialHistory.map((item) => ({
    id: item.id,
    url: item.url,
    prompt: item.prompt,
    timestamp: new Date(item.createdAt),
    settings: {
      width: item.dimensions?.width || 1024,
      height: item.dimensions?.height || 1024,
      steps: 30,
      guidanceScale: 7.5,
    },
  }));

  // Form state
  const [prompt, setPrompt] = useState("");
  const [settings, setSettings] = useState<ImageGenerationSettings>({
    width: 1024,
    height: 1024,
    steps: 30,
    guidanceScale: 7.5,
  });
  const [numImages, setNumImages] = useState<number>(1);

  // Source image state for image-to-image generation
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const sourceImageInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const topAnchorRef = useRef<HTMLDivElement>(null);

  // Scroll to top helper - smooth scroll using multiple methods
  const scrollToTop = () => {
    // Use a small delay to ensure DOM updates complete, then scroll smoothly
    requestAnimationFrame(() => {
      // Method 1: Scroll the top anchor into view
      if (topAnchorRef.current) {
        topAnchorRef.current.scrollIntoView({
          behavior: "smooth",
          block: "start",
          inline: "nearest",
        });
      }

      // Method 2: Find and scroll parent containers
      const scrollableParent = document.querySelector(
        '[class*="overflow-auto"], [class*="overflow-y-auto"], main, [role="main"]',
      );
      if (scrollableParent) {
        scrollableParent.scrollTo({ top: 0, behavior: "smooth" });
      }

      // Method 3: Window scroll
      window.scrollTo({ top: 0, behavior: "smooth" });

      // Focus input after scrolling
      setTimeout(() => {
        inputRef.current?.focus();
      }, 300);
    });
  };

  // Consolidated image state - current batch and selection (initialized with server history)
  const [imageState, setImageState] = useState<{
    currentImage: GeneratedImage | null;
    currentImages: GeneratedImage[];
    currentIndex: number;
    history: GeneratedImage[];
  }>({
    currentImage: null,
    currentImages: [],
    currentIndex: 0,
    history: convertedHistory,
  });

  // Consolidated request state
  const [requestState, setRequestState] = useState<{
    isLoading: boolean;
    error: string | null;
  }>({
    isLoading: false,
    error: null,
  });

  // Consolidated UI state
  const [uiState, setUiState] = useState<{
    activeTab: string;
    isFullscreenOpen: boolean;
    selectedExploreImage: GalleryItem | null;
  }>({
    activeTab: "creations",
    isFullscreenOpen: false,
    selectedExploreImage: null,
  });

  // Explore images state
  const [exploreState, setExploreState] = useState<{
    images: GalleryItem[];
    isLoading: boolean;
    error: string | null;
  }>({
    images: [],
    isLoading: false,
    error: null,
  });

  // Fetch explore images when tab changes to explore
  useEffect(() => {
    if (
      uiState.activeTab === "explore" &&
      exploreState.images.length === 0 &&
      !exploreState.isLoading
    ) {
      setExploreState((prev) => ({ ...prev, isLoading: true }));
      listExploreImages(20)
        .then((images) => {
          setExploreState({ images, isLoading: false, error: null });
        })
        .catch((err) => {
          setExploreState((prev) => ({
            ...prev,
            isLoading: false,
            error: err instanceof Error ? err.message : "Failed to load images",
          }));
        });
    }
  }, [uiState.activeTab, exploreState.images.length, exploreState.isLoading]);

  // Source image upload handlers
  const handleSourceImageSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const file = files[0];
    if (file.size > 10 * 1024 * 1024) {
      setRequestState((prev) => ({
        ...prev,
        error: "Source image too large. Maximum size is 10MB.",
      }));
      return;
    }

    if (!file.type.startsWith("image/")) {
      setRequestState((prev) => ({
        ...prev,
        error: "Invalid file type. Please upload an image.",
      }));
      return;
    }

    // Convert to base64
    const reader = new FileReader();
    reader.onload = () => {
      setSourceImage(reader.result as string);
    };
    reader.onerror = () => {
      setRequestState((prev) => ({
        ...prev,
        error: "Failed to read image file.",
      }));
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    setRequestState({ isLoading: true, error: null });
    setUiState((prev) => ({ ...prev, activeTab: "creations" }));

    try {
      const response = await fetch("/api/v1/generate-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          ...settings,
          numImages,
          ...(sourceImage && { sourceImage }),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setRequestState({
          isLoading: false,
          error: data.error || "Failed to generate image",
        });
        return;
      }

      // Handle multiple images array response
      if (Array.isArray(data.images) && data.images.length > 0) {
        const generatedBatch: GeneratedImage[] = data.images
          .map((img: { image?: string; url?: string }, index: number) => {
            const base64OrData =
              img.image && img.image.startsWith("data:")
                ? img.image
                : img?.image
                  ? `data:image/png;base64,${img.image}`
                  : "";
            const finalUrl = img.url ?? base64OrData;
            return {
              id: `${Date.now()}-${index}`,
              url: finalUrl,
              prompt,
              timestamp: new Date(),
              settings: { ...settings },
            };
          })
          .filter((g: GeneratedImage) => Boolean(g.url));

        if (generatedBatch.length > 0) {
          setImageState((prev) => ({
            ...prev,
            currentImages: generatedBatch,
            currentImage: generatedBatch[0],
            currentIndex: 0,
            history: [...generatedBatch, ...prev.history].slice(0, 12),
          }));
        }
      } else if (data.image) {
        // Backward compatibility: single image response
        const imageData = data.image.startsWith("data:")
          ? data.image
          : `data:image/png;base64,${data.image}`;

        const newImage: GeneratedImage = {
          id: Date.now().toString(),
          url: imageData,
          prompt,
          timestamp: new Date(),
          settings: { ...settings },
        };

        setImageState((prev) => ({
          ...prev,
          currentImages: [newImage],
          currentImage: newImage,
          currentIndex: 0,
          history: [newImage, ...prev.history].slice(0, 12),
        }));
      }
    } catch (err) {
      setRequestState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : "An error occurred",
      }));
    } finally {
      setRequestState((prev) => ({ ...prev, isLoading: false }));
    }
  };

  const handleDownload = (image: GeneratedImage) => {
    const link = document.createElement("a");
    link.href = image.url;
    link.download = `eliza-${image.id}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const selectSizePreset = (width: number, height: number) => {
    setSettings((prev) => ({ ...prev, width, height }));
  };

  // Get current size preset label
  const currentSizePreset = SIZE_PRESETS.find(
    (p) => p.width === settings.width && p.height === settings.height,
  );

  return (
    <div ref={containerRef} className="flex flex-col h-full w-full scroll-smooth">
      {/* Scroll anchor */}
      <div ref={topAnchorRef} className="absolute top-0" />

      {/* Top Input Bar */}
      <div>
        <div className="w-full">
          <div
            className={`relative rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden transition-all ${
              requestState.isLoading
                ? "opacity-60 pointer-events-none"
                : "focus-within:border-white/[0.15] focus-within:bg-white/[0.03]"
            }`}
          >
            {/* Loading Scanner */}
            {requestState.isLoading && (
              <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden pointer-events-none z-10">
                <div
                  className="absolute h-full w-24 bg-gradient-to-r from-transparent via-[#FF5800] to-transparent"
                  style={{
                    animation: "visor-scan 4.8s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                    boxShadow: "0 0 15px 3px rgba(255, 88, 0, 0.7)",
                    filter: "blur(0.5px)",
                  }}
                />
              </div>
            )}

            {/* Source Image Preview (if uploaded) */}
            {sourceImage && (
              <div className="flex items-center gap-3 px-4 pt-3 pb-2 border-b border-white/[0.06]">
                <div className="relative h-12 w-12 rounded overflow-hidden bg-black/40">
                  <img src={sourceImage} alt="Reference" className="h-full w-full object-cover" />
                </div>
                <span className="text-xs font-mono text-white/50">Reference image</span>
                <button
                  type="button"
                  onClick={() => {
                    setSourceImage(null);
                    if (sourceImageInputRef.current) {
                      sourceImageInputRef.current.value = "";
                    }
                  }}
                  className="ml-auto p-1 hover:bg-white/[0.06] rounded transition-colors"
                >
                  <X className="h-3.5 w-3.5 text-white/50" />
                </button>
              </div>
            )}

            {/* Textarea */}
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!requestState.isLoading && prompt.trim()) {
                    handleGenerate();
                  }
                }
              }}
              placeholder={
                sourceImage
                  ? "Describe how to modify the reference image..."
                  : "Describe the image you want to generate..."
              }
              disabled={requestState.isLoading}
              className="w-full bg-transparent px-5 pt-4 pb-4 text-xl text-white placeholder:text-white/40 focus:outline-none disabled:opacity-50 resize-none leading-relaxed"
              style={{ height: "25vh", minHeight: "150px", maxHeight: "350px" }}
            />

            {/* Bottom bar with buttons */}
            <div className="flex items-center justify-between px-2 py-2">
              {/* Left side - Reference image upload and Size selector */}
              <div className="flex items-center gap-1.5">
                {/* Reference Image Upload */}
                <input
                  ref={sourceImageInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleSourceImageSelect(e.target.files)}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => sourceImageInputRef.current?.click()}
                  disabled={requestState.isLoading}
                  className="h-8 w-8 rounded-lg hover:bg-white/[0.06] transition-colors disabled:opacity-40 disabled:pointer-events-none"
                >
                  <ImagePlus className="h-4 w-4 text-white/60" />
                </Button>

                {/* Size Selector Dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild disabled={requestState.isLoading}>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={requestState.isLoading}
                      className="h-8 gap-1.5 px-2.5 rounded-lg hover:bg-white/[0.06] transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    >
                      {currentSizePreset ? (
                        <>
                          <currentSizePreset.icon className="h-3.5 w-3.5 text-white/50" />
                          <span className="text-sm text-white/50">{currentSizePreset.label}</span>
                        </>
                      ) : (
                        <>
                          <Square className="h-3.5 w-3.5 text-white/50" />
                          <span className="text-sm text-white/50">Custom</span>
                        </>
                      )}
                      <svg
                        className="h-3.5 w-3.5 text-white/30"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="w-56 rounded-xl border-white/[0.08] bg-[#1a1a1a]/95 backdrop-blur-xl p-1"
                    align="start"
                    side="bottom"
                    sideOffset={8}
                  >
                    {SIZE_PRESETS.map((preset) => (
                      <DropdownMenuItem
                        key={preset.label}
                        className="flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer"
                        onSelect={() => selectSizePreset(preset.width, preset.height)}
                      >
                        <div className="flex items-center gap-3">
                          <preset.icon className="h-4 w-4 text-white/50" />
                          <div className="flex flex-col">
                            <span className="text-sm">{preset.label}</span>
                            <span className="text-[11px] text-white/40">
                              {preset.width}×{preset.height}
                            </span>
                          </div>
                        </div>
                        {settings.width === preset.width && settings.height === preset.height && (
                          <Check className="h-4 w-4 text-[#FF5800]" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Advanced Settings Dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild disabled={requestState.isLoading}>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={requestState.isLoading}
                      className="h-8 gap-1.5 px-2.5 rounded-lg hover:bg-white/[0.06] transition-colors disabled:opacity-40 disabled:pointer-events-none"
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5 text-white/50" />
                      <span className="text-sm text-white/50 hidden sm:inline">Settings</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="w-72 rounded-xl border-white/[0.08] bg-[#1a1a1a]/95 backdrop-blur-xl p-4"
                    align="start"
                    side="bottom"
                    sideOffset={8}
                  >
                    <div className="space-y-4">
                      {/* Steps */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-mono text-white/60">Steps</label>
                          <span className="text-xs font-mono text-white">{settings.steps}</span>
                        </div>
                        <Slider
                          value={[settings.steps]}
                          onValueChange={([value]) =>
                            setSettings((prev) => ({ ...prev, steps: value }))
                          }
                          min={10}
                          max={50}
                          step={5}
                          className="w-full [&_[role=slider]]:bg-[#FF5800] [&_[role=slider]]:border-[#FF5800]"
                        />
                      </div>

                      {/* Guidance Scale */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-mono text-white/60">Guidance Scale</label>
                          <span className="text-xs font-mono text-white">
                            {settings.guidanceScale.toFixed(1)}
                          </span>
                        </div>
                        <Slider
                          value={[settings.guidanceScale]}
                          onValueChange={([value]) =>
                            setSettings((prev) => ({
                              ...prev,
                              guidanceScale: value,
                            }))
                          }
                          min={1}
                          max={20}
                          step={0.5}
                          className="w-full [&_[role=slider]]:bg-[#FF5800] [&_[role=slider]]:border-[#FF5800]"
                        />
                      </div>

                      {/* Number of Images */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-mono text-white/60">Images</label>
                          <span className="text-xs font-mono text-white">{numImages}</span>
                        </div>
                        <Slider
                          value={[numImages]}
                          onValueChange={([value]) => setNumImages(value)}
                          min={1}
                          max={4}
                          step={1}
                          className="w-full [&_[role=slider]]:bg-[#FF5800] [&_[role=slider]]:border-[#FF5800]"
                        />
                      </div>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Right side - Generate button */}
              <Button
                type="button"
                onClick={handleGenerate}
                disabled={requestState.isLoading || !prompt.trim()}
                size="icon"
                className="h-8 w-8 rounded-xl bg-[#FF5800] hover:bg-[#e54e00] disabled:bg-white/10 transition-colors group"
              >
                {requestState.isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-white" />
                ) : (
                  <ArrowUp className="h-4 w-4 text-white group-disabled:text-neutral-400" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Area - Tabs */}
      <div className="flex-1 min-h-0 overflow-auto pt-8">
        {/* Error Display */}
        {requestState.error && (
          <div className="border border-rose-500/40 bg-rose-500/10 p-3 md:p-4 mb-4">
            <p className="text-xs md:text-sm font-mono text-rose-400 font-medium">
              {requestState.error}
            </p>
          </div>
        )}

        {/* Custom Tab Navigation */}
        <div className="flex items-center gap-8 mb-6">
          <button
            type="button"
            onClick={() => setUiState((prev) => ({ ...prev, activeTab: "creations" }))}
            className={`text-base font-medium transition-colors ${
              uiState.activeTab === "creations"
                ? "text-[#FF5800]"
                : "text-white/50 hover:text-white/70"
            }`}
          >
            My Creations
          </button>
          <button
            type="button"
            onClick={() => setUiState((prev) => ({ ...prev, activeTab: "explore" }))}
            className={`flex items-center gap-2 text-base font-medium transition-colors ${
              uiState.activeTab === "explore"
                ? "text-[#FF5800]"
                : "text-white/50 hover:text-white/70"
            }`}
          >
            <Search className="h-4 w-4" />
            Explore
          </button>
        </div>

        {/* My Creations Tab Content */}
        {uiState.activeTab === "creations" &&
          (imageState.history.length > 0 || requestState.isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {requestState.isLoading && (
                <div className="relative overflow-hidden rounded-lg border border-[#FF5800]/40 bg-black/40 animate-pulse">
                  <div className="relative aspect-square w-full flex items-center justify-center">
                    <div className="flex flex-col items-center gap-3">
                      <Loader2 className="h-8 w-8 text-[#FF5800] animate-spin" />
                      <span className="text-xs font-mono text-white/50">Generating...</span>
                    </div>
                  </div>
                </div>
              )}
              {imageState.history.map((image) => (
                <div
                  key={image.id}
                  className="group relative overflow-hidden p-0 rounded-lg border border-white/10 transition-colors"
                >
                  <div
                    className="relative aspect-square w-full bg-black/40 cursor-pointer"
                    onClick={() => {
                      setImageState((prev) => ({
                        ...prev,
                        currentImage: image,
                        currentImages: [image],
                        currentIndex: 0,
                      }));
                      setUiState((prev) => ({
                        ...prev,
                        isFullscreenOpen: true,
                      }));
                    }}
                  >
                    <Image
                      src={image.url}
                      alt={image.prompt}
                      fill
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                      className="object-cover group-hover:scale-105 transition-transform duration-300"
                      unoptimized
                    />
                    {/* Darker gradient overlay on hover */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-black/20 opacity-0 group-hover:opacity-100 transition-opacity z-10" />
                  </div>

                  {/* Hover Action Buttons */}
                  <div className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    {/* Download */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownload(image);
                          }}
                          className="p-2 rounded-lg bg-black/70 hover:bg-white/10 border border-white/20 transition-colors"
                        >
                          <Download className="h-4 w-4 text-white" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        className="text-xs bg-neutral-800 text-white/80 border-white/10"
                      >
                        Download image
                      </TooltipContent>
                    </Tooltip>

                    {/* Transform (use as reference) */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSourceImage(image.url);
                            scrollToTop();
                          }}
                          className="p-2 rounded-lg bg-black/70 hover:bg-white/10 border border-white/20 transition-colors"
                        >
                          <RefreshCw className="h-4 w-4 text-white" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        className="text-xs bg-neutral-800 text-white/80 border-white/10"
                      >
                        Use as reference for transformation
                      </TooltipContent>
                    </Tooltip>

                    {/* Re-use prompt */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPrompt(image.prompt);
                            scrollToTop();
                          }}
                          className="p-2 rounded-lg bg-black/70 hover:bg-white/10 border border-white/20 transition-colors"
                        >
                          <Copy className="h-4 w-4 text-white" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        className="text-xs bg-neutral-800 text-white/80 border-white/10"
                      >
                        Re-use this prompt
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  {/* Prompt text at bottom */}
                  <div className="absolute bottom-0 left-0 right-0 p-2 md:p-3 text-white opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    <p className="text-xs font-mono line-clamp-2 leading-relaxed">{image.prompt}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <BrandCard className="relative border-dashed">
              <CornerBrackets size="md" className="opacity-50" />
              <div className="relative z-10 p-8 md:p-12 lg:p-20 text-center">
                <div className="flex flex-col items-center space-y-3 md:space-y-4">
                  <ImageIcon className="h-8 md:h-10 lg:h-12 w-8 md:w-10 lg:w-12 text-[#FF5800]" />
                  <div className="space-y-2">
                    <h3 className="text-base md:text-lg font-mono font-semibold text-white">
                      No Creations Yet
                    </h3>
                    <p className="text-xs md:text-sm font-mono text-white/60">
                      Describe your vision above and generate your first image
                    </p>
                  </div>
                </div>
              </div>
            </BrandCard>
          ))}

        {/* Explore Tab Content */}
        {uiState.activeTab === "explore" &&
          (exploreState.isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="relative overflow-hidden rounded-lg border border-white/10 bg-black/40 animate-pulse"
                >
                  <div className="aspect-square w-full" />
                </div>
              ))}
            </div>
          ) : exploreState.error ? (
            <BrandCard className="relative border-dashed border-rose-500/40">
              <div className="relative z-10 p-8 text-center">
                <p className="text-sm font-mono text-rose-400">{exploreState.error}</p>
              </div>
            </BrandCard>
          ) : exploreState.images.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
              {exploreState.images.map((image) => (
                <div
                  key={image.id}
                  className="group relative overflow-hidden p-0 rounded-lg border border-white/10 transition-colors"
                >
                  <div
                    className="relative aspect-square w-full bg-black/40 cursor-pointer"
                    onClick={() =>
                      setUiState((prev) => ({
                        ...prev,
                        selectedExploreImage: image,
                      }))
                    }
                  >
                    <Image
                      src={image.url}
                      alt={image.prompt}
                      fill
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                      className="object-cover group-hover:scale-105 transition-transform duration-300"
                      unoptimized
                    />
                    {/* Darker gradient overlay on hover */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-black/20 opacity-0 group-hover:opacity-100 transition-opacity z-10" />
                  </div>

                  {/* Hover Action Buttons */}
                  <div className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    {/* Transform (use as reference) */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSourceImage(image.url);
                            scrollToTop();
                          }}
                          className="p-2 rounded-lg bg-black/70 hover:bg-white/10 border border-white/20 transition-colors"
                        >
                          <RefreshCw className="h-4 w-4 text-white" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        className="text-xs bg-neutral-800 text-white/80 border-white/10"
                      >
                        Use as reference
                      </TooltipContent>
                    </Tooltip>

                    {/* Re-use prompt */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPrompt(image.prompt);
                            scrollToTop();
                          }}
                          className="p-2 rounded-lg bg-black/70 hover:bg-white/10 border border-white/20 transition-colors"
                        >
                          <Copy className="h-4 w-4 text-white" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        className="text-xs bg-neutral-800 text-white/80 border-white/10"
                      >
                        Use this prompt
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  {/* Prompt text at bottom */}
                  <div className="absolute bottom-0 left-0 right-0 p-2 md:p-3 text-white opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    <p className="text-xs font-mono line-clamp-2 leading-relaxed">{image.prompt}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <BrandCard className="relative border-dashed">
              <CornerBrackets size="md" className="opacity-50" />
              <div className="relative z-10 p-8 md:p-12 lg:p-20 text-center">
                <div className="flex flex-col items-center space-y-3 md:space-y-4">
                  <Search className="h-8 md:h-10 lg:h-12 w-8 md:w-10 lg:w-12 text-[#FF5800]" />
                  <div className="space-y-2">
                    <h3 className="text-base md:text-lg font-mono font-semibold text-white">
                      No Images to Explore
                    </h3>
                    <p className="text-xs md:text-sm font-mono text-white/60">
                      Check back later for community creations
                    </p>
                  </div>
                </div>
              </div>
            </BrandCard>
          ))}
      </div>

      {/* Explore Image Detail Modal */}
      <Dialog
        open={!!uiState.selectedExploreImage}
        onOpenChange={(open) => {
          if (!open) setUiState((prev) => ({ ...prev, selectedExploreImage: null }));
        }}
      >
        <DialogContent
          className="!max-w-4xl !w-[95vw] p-0 rounded-lg bg-black/50 backdrop-blur-2xl border border-white/10 shadow-2xl overflow-hidden"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Image Details</DialogTitle>
          {uiState.selectedExploreImage && (
            <div className="flex flex-col md:flex-row min-h-[400px]">
              {/* Close button */}
              <button
                type="button"
                onClick={() =>
                  setUiState((prev) => ({
                    ...prev,
                    selectedExploreImage: null,
                  }))
                }
                className="absolute top-4 right-4 z-10 p-2 rounded-md bg-white/5 hover:bg-white/10 transition-colors"
              >
                <X className="h-5 w-5 text-white" />
              </button>

              {/* Left - Image */}
              <div className="relative w-full md:w-[400px] h-64 md:h-auto bg-black flex-shrink-0">
                <Image
                  src={uiState.selectedExploreImage.url}
                  alt={uiState.selectedExploreImage.prompt}
                  fill
                  className="object-contain"
                  unoptimized
                />
              </div>

              {/* Right - Details */}
              <div className="flex-1 p-8 space-y-6">
                {/* Prompt Section */}
                <div className="space-y-3">
                  <label className="text-xs text-white/50 uppercase tracking-wide">Prompt</label>
                  <p className="text-base text-white leading-relaxed">
                    {uiState.selectedExploreImage.prompt}
                  </p>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-3">
                  {/* Transform (use as reference) */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          setSourceImage(uiState.selectedExploreImage?.url ?? "");
                          setUiState((prev) => ({
                            ...prev,
                            selectedExploreImage: null,
                          }));
                          scrollToTop();
                        }}
                        className="p-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                      >
                        <RefreshCw className="h-4 w-4 text-white" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      className="text-xs bg-neutral-800 text-white/80 border-white/10"
                    >
                      Use as reference
                    </TooltipContent>
                  </Tooltip>

                  {/* Re-use prompt */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          setPrompt(uiState.selectedExploreImage?.prompt ?? "");
                          setUiState((prev) => ({
                            ...prev,
                            selectedExploreImage: null,
                          }));
                          scrollToTop();
                        }}
                        className="p-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                      >
                        <Copy className="h-4 w-4 text-white" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      className="text-xs bg-neutral-800 text-white/80 border-white/10"
                    >
                      Use this prompt
                    </TooltipContent>
                  </Tooltip>
                </div>

                {/* Metadata Grid */}
                <div className="grid grid-cols-2 gap-x-8 gap-y-4 pt-4 border-t border-white/5">
                  {/* Model */}
                  {uiState.selectedExploreImage.model && (
                    <div className="space-y-1">
                      <label className="text-xs text-white/50 uppercase tracking-wide">Model</label>
                      <p className="text-sm text-white">{uiState.selectedExploreImage.model}</p>
                    </div>
                  )}

                  {/* Aspect Ratio */}
                  {uiState.selectedExploreImage.dimensions && (
                    <div className="space-y-1">
                      <label className="text-xs text-white/50 uppercase tracking-wide">
                        Aspect Ratio
                      </label>
                      <p className="text-sm text-white">
                        {(() => {
                          const w = uiState.selectedExploreImage.dimensions?.width ?? 1;
                          const h = uiState.selectedExploreImage.dimensions?.height ?? 1;
                          const gcd = (a: number, b: number): number =>
                            b === 0 ? a : gcd(b, a % b);
                          const d = gcd(w, h);
                          return `${w / d}:${h / d}`;
                        })()}
                      </p>
                    </div>
                  )}

                  {/* Resolution */}
                  {uiState.selectedExploreImage.dimensions && (
                    <div className="space-y-1">
                      <label className="text-xs text-white/50 uppercase tracking-wide">
                        Resolution
                      </label>
                      <p className="text-sm text-white">
                        {uiState.selectedExploreImage.dimensions.width}×
                        {uiState.selectedExploreImage.dimensions.height}
                      </p>
                    </div>
                  )}

                  {/* File Type */}
                  {uiState.selectedExploreImage.mimeType && (
                    <div className="space-y-1">
                      <label className="text-xs text-white/50 uppercase tracking-wide">
                        File Type
                      </label>
                      <p className="text-sm text-white">
                        {uiState.selectedExploreImage.mimeType.split("/")[1]?.toUpperCase()}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Fullscreen Image Modal */}
      <Dialog
        open={uiState.isFullscreenOpen}
        onOpenChange={(open) => setUiState((prev) => ({ ...prev, isFullscreenOpen: open }))}
      >
        <DialogContent
          className="!max-w-[99vw] !max-h-[99vh] !w-[99vw] !h-[99vh] p-0 bg-black/80 border-white/10 sm:!max-w-[99vw] md:!max-w-[99vw] lg:!max-w-[99vw]"
          showCloseButton={false}
        >
          {/* Screen reader accessible title (visually hidden) */}
          <DialogTitle className="sr-only">
            {imageState.currentImages[imageState.currentIndex]?.prompt ??
              imageState.currentImage?.prompt ??
              "Image preview"}
          </DialogTitle>
          <div className="relative w-full h-full flex items-center justify-center p-4 md:p-6">
            {imageState.currentImage && (
              <>
                <div className="relative w-full h-full flex items-center justify-center pb-32 md:pb-40">
                  <Image
                    src={
                      imageState.currentImages[imageState.currentIndex]?.url ??
                      imageState.currentImage.url
                    }
                    alt={
                      imageState.currentImages[imageState.currentIndex]?.prompt ??
                      imageState.currentImage.prompt
                    }
                    width={3000}
                    height={3000}
                    className="object-contain max-w-full max-h-full w-auto h-auto"
                    unoptimized
                  />
                </div>

                {/* Close button */}
                <DialogClose className="absolute top-2 md:top-4 right-2 md:right-4 z-50 border border-white/20 bg-black/60 p-2 hover:bg-[#FF580020] hover:border-[#FF5800]/40 transition-colors">
                  <X className="h-4 md:h-5 w-4 md:w-5 text-white" />
                </DialogClose>

                {/* Image info overlay */}
                <div className="absolute bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-4 pt-6 pb-4 md:px-6 md:pt-10 md:pb-6 lg:px-8 lg:pt-12 lg:pb-8 space-y-2 md:space-y-3 max-h-[50vh] overflow-y-auto">
                  <p className="text-xs md:text-sm font-mono text-white/90 leading-relaxed max-w-3xl break-words">
                    {imageState.currentImages[imageState.currentIndex]?.prompt ??
                      imageState.currentImage.prompt}
                  </p>
                  <div className="flex items-center gap-2 text-xs flex-wrap">
                    <span className="bg-white/10 px-2 py-1 font-mono text-white whitespace-nowrap">
                      {imageState.currentImages[imageState.currentIndex]?.settings.width ??
                        imageState.currentImage.settings.width}
                      ×
                      {imageState.currentImages[imageState.currentIndex]?.settings.height ??
                        imageState.currentImage.settings.height}
                    </span>
                    <span className="bg-white/10 px-2 py-1 font-mono text-white whitespace-nowrap">
                      {imageState.currentImages[imageState.currentIndex]?.settings.steps ??
                        imageState.currentImage.settings.steps}{" "}
                      steps
                    </span>
                    <span className="bg-white/10 px-2 py-1 font-mono text-white whitespace-nowrap">
                      CFG{" "}
                      {imageState.currentImages[imageState.currentIndex]?.settings.guidanceScale ??
                        imageState.currentImage.settings.guidanceScale}
                    </span>
                    {imageState.currentImages.length > 1 && (
                      <span className="bg-[#FF580020] border border-[#FF5800]/40 px-2 py-1 font-mono text-[#FF5800] whitespace-nowrap">
                        {imageState.currentIndex + 1}/{imageState.currentImages.length}
                      </span>
                    )}
                  </div>

                  {/* Navigation buttons for multiple images */}
                  {imageState.currentImages.length > 1 && (
                    <div className="flex items-center gap-2 pt-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => {
                          const newIndex =
                            imageState.currentIndex > 0
                              ? imageState.currentIndex - 1
                              : imageState.currentImages.length - 1;
                          setImageState((prev) => ({
                            ...prev,
                            currentIndex: newIndex,
                            currentImage: prev.currentImages[newIndex],
                          }));
                        }}
                        disabled={imageState.currentImages.length <= 1}
                        className="px-3 py-2 border border-white/20 bg-black/60 text-white hover:bg-white/5 transition-colors disabled:opacity-50"
                      >
                        <span className="text-xs font-mono">Previous</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const newIndex =
                            imageState.currentIndex < imageState.currentImages.length - 1
                              ? imageState.currentIndex + 1
                              : 0;
                          setImageState((prev) => ({
                            ...prev,
                            currentIndex: newIndex,
                            currentImage: prev.currentImages[newIndex],
                          }));
                        }}
                        disabled={imageState.currentImages.length <= 1}
                        className="px-3 py-2 border border-white/20 bg-black/60 text-white hover:bg-white/5 transition-colors disabled:opacity-50"
                      >
                        <span className="text-xs font-mono">Next</span>
                      </button>
                      <button
                        type="button"
                        className="px-3 py-2 border border-white/20 bg-black/60 text-white hover:bg-white/5 transition-colors ml-auto flex items-center gap-2"
                        onClick={() =>
                          handleDownload(
                            imageState.currentImages[imageState.currentIndex] ??
                              imageState.currentImage!,
                          )
                        }
                      >
                        <Download className="h-4 w-4" />
                        <span className="text-xs font-mono">Download</span>
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
