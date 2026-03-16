/**
 * Reusable avatar/character VRM selector.
 *
 * Shows a single row/grid of bundled VRM avatars as thumbnail images.
 * The selected avatar gets a highlight ring. No text labels.
 * Supports drag-and-drop for custom VRM uploads.
 */

import {
  getVrmPreviewUrl,
  getVrmTitle,
  useApp,
  VRM_COUNT,
} from "@elizaos/app-core/state";
import { alertDesktopMessage } from "@elizaos/app-core/utils";
import { useCallback, useRef, useState } from "react";

export interface AvatarSelectorProps {
  /** Currently selected index (1-N for bundled, 0 for custom) */
  selected: number;
  /** Called when a built-in avatar is selected */
  onSelect: (index: number) => void;
  /** Called when a custom VRM is uploaded */
  onUpload?: (file: File) => void;
  /** Whether to show the upload option */
  showUpload?: boolean;
  /** Expand selector to fill row width with responsive tile sizes */
  fullWidth?: boolean;
  /** Whether an avatar is currently loading (disables selection) */
  loading?: boolean;
}

function isVrmFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".vrm");
}

async function validateVrmFile(file: File): Promise<string | null> {
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer.slice(0, 32));
    const textHeader = new TextDecoder().decode(bytes);
    if (textHeader.startsWith("version https://git-lfs.github.com/spec/v1")) {
      return "This .vrm is a Git LFS pointer, not the real model file. Export/download the actual VRM binary.";
    }
    const isGlbMagic =
      bytes.length >= 4 &&
      bytes[0] === 0x67 && // g
      bytes[1] === 0x6c && // l
      bytes[2] === 0x54 && // T
      bytes[3] === 0x46; // F
    if (!isGlbMagic) {
      return "Invalid VRM file. Please select a valid .vrm binary.";
    }
    return null;
  } catch {
    return "Could not read the selected file. Please try another .vrm.";
  }
}

export function AvatarSelector({
  selected,
  onSelect,
  onUpload,
  showUpload = true,
  fullWidth = false,
  loading = false,
}: AvatarSelectorProps) {
  const { t } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleVrmFile = useCallback(
    (file: File) => {
      if (!isVrmFile(file)) {
        void alertDesktopMessage({
          title: "Invalid Avatar File",
          message: "Please select a .vrm file.",
          type: "error",
        });
        return;
      }
      void (async () => {
        const validationError = await validateVrmFile(file);
        if (validationError) {
          await alertDesktopMessage({
            title: "Invalid Avatar File",
            message: validationError,
            type: "error",
          });
          return;
        }
        onUpload?.(file);
        onSelect(0);
      })();
    },
    [onUpload, onSelect],
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleVrmFile(file);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleVrmFile(file);
    },
    [handleVrmFile],
  );

  const avatarIndices = Array.from({ length: VRM_COUNT }, (_, i) => i + 1);
  const containerClass = fullWidth
    ? "flex flex-row gap-2 w-full items-center"
    : "flex flex-wrap gap-3 justify-start";
  const containerStyle = undefined;
  const avatarButtonClass = fullWidth
    ? "relative w-14 h-14 shrink-0 rounded-lg overflow-hidden cursor-pointer transition-all"
    : "relative w-24 h-24 shrink-0 rounded-lg overflow-hidden cursor-pointer transition-all";
  const uploadButtonClass = fullWidth
    ? "w-14 h-14 shrink-0 rounded-lg border-2 flex flex-col items-center justify-center cursor-pointer transition-all"
    : "w-24 h-24 shrink-0 rounded-lg border-2 flex flex-col items-center justify-center cursor-pointer transition-all";

  return (
    <div className={fullWidth ? "w-full" : undefined}>
      <div className={containerClass} style={containerStyle}>
        {avatarIndices.map((i) => (
          <button
            key={i}
            className={`${avatarButtonClass} ${
              selected === i
                ? "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--card)] scale-105"
                : "opacity-60 hover:opacity-100 hover:scale-105"
            } ${loading ? "cursor-wait pointer-events-none" : ""}`}
            onClick={() => !loading && onSelect(i)}
            disabled={loading}
            type="button"
          >
            <img
              src={getVrmPreviewUrl(i)}
              alt={getVrmTitle(i)}
              draggable={false}
              className={`w-full h-full object-cover select-none ${loading && selected !== i ? "opacity-40" : ""}`}
            />
            {loading && selected === i && (
              <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              </div>
            )}
          </button>
        ))}

        {/* Upload custom VRM — click or drag-and-drop */}
        {showUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".vrm"
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              className={`${uploadButtonClass} ${
                dragOver
                  ? "border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)] scale-105 border-solid"
                  : selected === 0
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--card)] scale-105 border-solid"
                    : "border-[var(--border)] text-[var(--muted)] opacity-60 hover:opacity-100 hover:border-[var(--accent)] hover:scale-105 border-dashed"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              title={t("avatarselector.UploadCustomVrm")}
              type="button"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-label="Upload VRM"
              >
                <title>{t("avatarselector.UploadVRM")}</title>
                {dragOver ? (
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5-5 5 5M12 5v10" />
                ) : (
                  <path d="M12 5v14m-7-7h14" />
                )}
              </svg>
              {dragOver && (
                <span className="text-[10px] mt-1 font-medium">
                  {t("avatarselector.dropVrm")}
                </span>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
