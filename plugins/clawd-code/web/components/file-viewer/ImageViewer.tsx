"use client";

import { useState, useRef } from "react";
import { ZoomIn, ZoomOut, Maximize2, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface ImageViewerProps {
  src: string;
  path: string;
}

export function ImageViewer({ src, path }: ImageViewerProps) {
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState<"fit" | "actual">("fit");
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleZoomIn = () => setZoom((z) => Math.min(z * 1.25, 8));
  const handleZoomOut = () => setZoom((z) => Math.max(z / 1.25, 0.1));
  const handleFitToggle = () => {
    setFitMode((m) => (m === "fit" ? "actual" : "fit"));
    setZoom(1);
  };

  const isSvg = path.endsWith(".svg");
  const hasTransparency = path.endsWith(".png") || path.endsWith(".gif") ||
    path.endsWith(".webp") || path.endsWith(".svg");

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-surface-500">
        <ImageIcon className="w-10 h-10" />
        <p className="text-sm">Failed to load image</p>
        <p className="text-xs text-surface-600">{path}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-surface-800 bg-surface-900/50">
        <button
          onClick={handleZoomOut}
          className="p-1 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-800 transition-colors"
          title="Zoom out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="text-xs text-surface-400 w-12 text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={handleZoomIn}
          className="p-1 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-800 transition-colors"
          title="Zoom in"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <div className="w-px h-4 bg-surface-800 mx-1" />
        <button
          onClick={handleFitToggle}
          className={cn(
            "flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors",
            fitMode === "fit"
              ? "text-brand-400 bg-brand-900/30"
              : "text-surface-500 hover:text-surface-200 hover:bg-surface-800"
          )}
          title={fitMode === "fit" ? "Switch to actual size" : "Switch to fit width"}
        >
          <Maximize2 className="w-3 h-3" />
          {fitMode === "fit" ? "Fit" : "Actual"}
        </button>
      </div>

      {/* Image container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto flex items-center justify-center p-4"
        style={{
          backgroundImage: hasTransparency
            ? "linear-gradient(45deg, #3f3f46 25%, transparent 25%), linear-gradient(-45deg, #3f3f46 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #3f3f46 75%), linear-gradient(-45deg, transparent 75%, #3f3f46 75%)"
            : undefined,
          backgroundSize: hasTransparency ? "16px 16px" : undefined,
          backgroundPosition: hasTransparency ? "0 0, 0 8px, 8px -8px, -8px 0px" : undefined,
          backgroundColor: hasTransparency ? "#27272a" : "#1a1a1e",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={path.split("/").pop()}
          onError={() => setError(true)}
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "center center",
            maxWidth: fitMode === "fit" ? "100%" : "none",
            maxHeight: fitMode === "fit" ? "100%" : "none",
            imageRendering: zoom > 2 ? "pixelated" : "auto",
          }}
          className="transition-transform duration-150 shadow-lg"
          draggable={false}
        />
      </div>
    </div>
  );
}
