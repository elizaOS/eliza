/**
 * Avatar upload component with drag-and-drop support.
 * Handles file validation, upload, and preview display.
 *
 * @param props - Avatar upload configuration
 * @param props.value - Current avatar URL
 * @param props.onChange - Callback when avatar URL changes
 * @param props.name - Optional character name for display
 * @param props.size - Avatar size variant (sm or lg)
 */

"use client";

import { useState, useRef, forwardRef, useImperativeHandle } from "react";
import { X, Loader2, ImagePlus } from "lucide-react";
import { uploadCharacterAvatar } from "@/app/actions/characters";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface AvatarUploadProps {
  value?: string;
  onChange: (url: string) => void;
  name?: string;
  size?: "sm" | "lg" | "xl";
}

export interface AvatarUploadRef {
  triggerUpload: () => void;
}

export const AvatarUpload = forwardRef<AvatarUploadRef, AvatarUploadProps>(
  function AvatarUpload({ value, onChange, name, size = "lg" }, ref) {
    const [isUploading, setIsUploading] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      triggerUpload: () => fileInputRef.current?.click(),
    }));

    const handleFileSelect = async (files: FileList | null) => {
      if (!files || files.length === 0) return;

      const file = files[0];
      if (file.size > 5 * 1024 * 1024) {
        toast.error("File too large. Maximum size is 5MB.");
        return;
      }

      if (!file.type.startsWith("image/")) {
        toast.error("Invalid file type. Please upload an image.");
        return;
      }

      setIsUploading(true);
      const formData = new FormData();
      formData.append("file", file);

      const result = await uploadCharacterAvatar(formData);

      if (result.success && result.url) {
        onChange(result.url);
        toast.success("Avatar uploaded! 🔥");
      } else {
        toast.error(result.error || "Failed to upload avatar");
      }
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      handleFileSelect(e.dataTransfer.files);
    };

    const sizeClasses =
      size === "xl"
        ? "h-28 w-28 sm:h-36 sm:w-36"
        : size === "lg"
          ? "h-32 w-32"
          : "h-20 w-20";
    const iconSize =
      size === "xl"
        ? "h-8 w-8 sm:h-10 sm:w-10"
        : size === "lg"
          ? "h-8 w-8"
          : "h-5 w-5";

    return (
      <div className={cn("relative group", sizeClasses)}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          disabled={isUploading}
          className={cn(
            sizeClasses,
            "relative rounded-2xl overflow-hidden transition-all duration-300",
            "border-2",
            isDragging
              ? "border-dashed border-[#FF5800] bg-[#FF5800]/10 scale-105"
              : value
                ? "border-solid border-white/10"
                : "border-dashed border-white/20 hover:border-[#FF5800]/50",
            "focus:outline-none focus:ring-2 focus:ring-[#FF5800] focus:ring-offset-2 focus:ring-offset-black",
            isUploading && "animate-pulse",
          )}
        >
          {value ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- Handles blob URLs from file uploads which don't work with next/image */}
              <img
                src={value}
                alt={name || "Avatar"}
                className="h-full w-full object-cover"
              />
              {/* Hover Overlay */}
              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <ImagePlus className="h-6 w-6 text-white" />
              </div>
            </>
          ) : (
            <div
              className={cn(
                "h-full w-full flex flex-col items-center justify-center gap-2",
                "bg-gradient-to-br from-white/5 to-white/10",
              )}
            >
              {isUploading ? (
                <Loader2
                  className={cn(iconSize, "text-[#FF5800] animate-spin")}
                />
              ) : (
                <>
                  <ImagePlus
                    className={cn(
                      iconSize,
                      "text-neutral-500 group-hover:text-[#FF5800] transition-colors",
                    )}
                  />
                  {(size === "lg" || size === "xl") && (
                    <span className="text-xs font-medium text-neutral-400 group-hover:text-white transition-colors">
                      Drop or click
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </button>

        {/* Remove Button */}
        {value && !isUploading && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            className={cn(
              "absolute -top-1 -right-1 p-1 rounded-lg",
              "bg-black/80 backdrop-blur-sm border border-white/20 text-white/70",
              "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all",
              "hover:bg-red-500/80 hover:border-red-500/50 hover:text-white",
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => handleFileSelect(e.target.files)}
          className="hidden"
        />
      </div>
    );
  },
);
