/**
 * Avatar generator component for selecting or generating character avatars.
 * Supports built-in avatar selection, random generation, and AI-powered avatar generation.
 *
 * @param props - Avatar generator configuration
 * @param props.characterName - Character name for avatar generation
 * @param props.characterDescription - Optional character description
 * @param props.currentAvatarUrl - Current avatar URL
 * @param props.onAvatarChange - Callback when avatar changes
 * @param props.className - Additional CSS classes
 */

"use client";

import { Button, ScrollArea } from "../primitives";
import Image from "../../runtime/image";
import { ImagePlus, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { generateDefaultAvatarUrl, getAvailableAvatarStyles } from "@/lib/utils/default-avatar";
import { AvatarUpload, type AvatarUploadRef } from "./avatar-upload";

interface AvatarGeneratorProps {
  characterName: string;
  characterDescription?: string;
  currentAvatarUrl?: string;
  onAvatarChange: (avatarUrl: string) => void;
  className?: string;
}

export function AvatarGenerator({
  characterName,
  characterDescription,
  currentAvatarUrl,
  onAvatarChange,
  className,
}: AvatarGeneratorProps) {
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);
  const avatarUploadRef = useRef<AvatarUploadRef>(null);
  const availableAvatars = getAvailableAvatarStyles();

  const handleSelectAvatar = (avatarUrl: string) => {
    onAvatarChange(avatarUrl);
    toast.success("Avatar selected");
  };

  const handleRandomize = () => {
    // Pass undefined to get truly random selection (not name-based deterministic)
    onAvatarChange(generateDefaultAvatarUrl());
    toast.success("Random avatar selected");
  };

  const handleGenerateAIAvatar = async () => {
    if (!characterName) {
      toast.error("Please enter a character name first");
      return;
    }

    setIsGeneratingAI(true);

    const description = characterDescription || characterName;
    const prompt = `Professional avatar portrait for an AI character named "${characterName}". ${description}. Clean circular composition, dark background (#0A0A0A), high quality digital illustration style, suitable for profile picture. Modern, sleek design.`;

    const response = await fetch("/api/v1/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, aspectRatio: "1:1", numImages: 1 }),
    });

    try {
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to generate avatar");
      }

      const data = await response.json();

      if (data.images?.[0]) {
        const newAvatarUrl = data.images[0].url || data.images[0].image;
        if (!newAvatarUrl) throw new Error("No valid image URL in response");
        onAvatarChange(newAvatarUrl);
        toast.success("AI avatar generated!");
      } else {
        throw new Error("No image returned");
      }
    } catch (error) {
      console.error("Error generating AI avatar:", error);
      toast.error(error instanceof Error ? error.message : "Failed to generate AI avatar");
    } finally {
      setIsGeneratingAI(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-6 sm:gap-10 h-full", className)}>
      {/* Centered Avatar Preview */}
      <div className="shrink-0 flex flex-col items-center gap-4">
        <AvatarUpload
          ref={avatarUploadRef}
          value={currentAvatarUrl}
          onChange={onAvatarChange}
          name={characterName}
          size="xl"
        />

        {/* Action buttons */}
        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={handleRandomize}
            className="rounded-full border border-white/20 bg-white/10 text-white hover:bg-white/15 px-6 py-2"
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Random
          </Button>

          <Button
            variant="outline"
            onClick={handleGenerateAIAvatar}
            disabled={isGeneratingAI || !characterName}
            className="rounded-full border border-[#FF5800]/50 bg-[#FF5800]/40 text-white hover:bg-[#FF5800]/55 hover:border-[#FF5800]/90 px-4 py-2 w-32"
          >
            {isGeneratingAI ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-1" />
            )}
            {isGeneratingAI ? "Generating" : "AI Avatar"}
          </Button>
        </div>
      </div>

      {/* Avatar Selection Grid */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full rounded-l-lg overflow-y-auto sm:scrollbar-thin sm:scrollbar-thumb-brand-orange sm:scrollbar-track-black">
          <div className="grid grid-cols-5 sm:grid-cols-7 gap-1 sm:gap-1.5">
            {/* Upload button */}
            <button
              onClick={() => avatarUploadRef.current?.triggerUpload()}
              className={cn(
                "group relative w-full aspect-square rounded-lg overflow-hidden border-2 transition-all",
                "border-dashed border-white/20 hover:border-[#FF5800]/50",
                "bg-white/5 hover:bg-white/10",
                "flex items-center justify-center",
              )}
              title="Upload your own"
            >
              <ImagePlus className="size-6 text-neutral-500 group-hover:text-[#FF5800] transition-colors" />
            </button>
            {availableAvatars.map((avatar) => {
              const isSelected = currentAvatarUrl === avatar.url;
              return (
                <button
                  key={avatar.id}
                  onClick={() => handleSelectAvatar(avatar.url)}
                  className={cn(
                    "relative w-full aspect-square rounded-lg overflow-hidden border-2 transition-all",
                    isSelected
                      ? "border-[#FF5800] ring-2 ring-[#FF5800]/30"
                      : "border-transparent hover:border-[#FF5800]/50",
                  )}
                  title={avatar.name}
                >
                  <Image
                    src={avatar.url}
                    alt={avatar.name}
                    fill
                    className="object-cover size-full"
                    draggable={false}
                    sizes="160px"
                  />
                  {isSelected && <div className="absolute inset-0 bg-[#FF5800]/20" />}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
