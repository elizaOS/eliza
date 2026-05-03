/**
 * Gallery grid component displaying media items in a responsive grid layout.
 * Supports image/video preview, deletion, and download functionality.
 *
 * @param props - Gallery grid configuration
 * @param props.items - Array of gallery items to display
 * @param props.onItemDeleted - Optional callback when item is deleted
 */

"use client";

import {
  BrandButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from "@elizaos/cloud-ui";
import Image from "@elizaos/cloud-ui/runtime/image";
import { DownloadIcon, TrashIcon } from "@radix-ui/react-icons";
import { format } from "date-fns";
import { Eye, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { GalleryItem } from "@/lib/types/gallery";

async function deleteMedia(generationId: string): Promise<boolean> {
  const res = await fetch(`/api/v1/gallery/${encodeURIComponent(generationId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to delete media (${res.status})`);
  }
  return true;
}

interface GalleryGridProps {
  items: GalleryItem[];
  onItemDeleted?: (itemId: string, itemType: "image" | "video") => void;
}

export function GalleryGrid({ items, onItemDeleted }: GalleryGridProps) {
  const [selectedItem, setSelectedItem] = useState<GalleryItem | null>(null);
  const [deleteConfirmItem, setDeleteConfirmItem] = useState<GalleryItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async (item: GalleryItem) => {
    setIsDeleting(true);
    await deleteMedia(item.id);
    toast.success("Media deleted successfully");
    setDeleteConfirmItem(null);
    onItemDeleted?.(item.id, item.type as "image" | "video");
    setIsDeleting(false);
  };

  const handleDownload = async (item: GalleryItem) => {
    const response = await fetch(item.url);
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${item.type}-${item.id}.${item.mimeType?.split("/")[1] || "file"}`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    toast.success("Download started");
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="rounded-full bg-[#FF580020] border border-[#FF5800]/40 p-6 mb-4">
          <Eye className="w-12 h-12 text-[#FF5800]" />
        </div>
        <h3 className="text-xl font-semibold mb-2 text-white">No media yet</h3>
        <p className="text-white/60 max-w-md">
          Generate some images or videos to see them appear in your gallery
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            onClick={() => setSelectedItem(item)}
            className={`overflow-hidden group cursor-pointer rounded-md relative bg-black/60 ${item.type === "image" ? "aspect-square" : "aspect-video"}`}
          >
            {item.type === "image" ? (
              <Image
                src={item.url}
                alt={item.prompt}
                fill
                className="object-cover"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
              />
            ) : (
              <video src={item.url} className="w-full h-full object-cover" preload="metadata" />
            )}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
              <Eye className="w-8 h-8 text-[#FF5800] opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        ))}
      </div>

      {/* Detail Dialog */}
      <Dialog open={!!selectedItem} onOpenChange={(open) => !open && setSelectedItem(null)}>
        <DialogContent
          className="!max-w-[99vw] !max-h-[99vh] !w-[99vw] !h-[99vh] p-0 bg-black/80 border-white/10 sm:!max-w-[99vw] md:!max-w-[99vw] lg:!max-w-[99vw]"
          showCloseButton={false}
        >
          {/* Screen reader accessible title (visually hidden) */}
          <DialogTitle className="sr-only">{selectedItem?.prompt || "Media preview"}</DialogTitle>
          {selectedItem && (
            <div className="relative w-full h-full flex items-center justify-center p-4 md:p-6">
              {/* Main Content */}
              <div className="relative w-full h-full flex items-center justify-center pb-40 md:pb-48">
                {selectedItem.type === "image" ? (
                  <Image
                    src={selectedItem.url}
                    alt={selectedItem.prompt}
                    width={3000}
                    height={3000}
                    className="object-contain max-w-full max-h-full w-auto h-auto"
                    unoptimized
                    priority
                  />
                ) : (
                  <video
                    src={selectedItem.url}
                    controls
                    className="max-w-full max-h-full object-contain"
                  />
                )}
              </div>

              {/* Close button */}
              <DialogClose className="absolute top-4 right-4 z-50 rounded-none border border-white/20 bg-black/60 p-2 hover:bg-[#FF580020] hover:border-[#FF5800]/40 transition-colors">
                <X className="h-5 w-5 text-white" />
              </DialogClose>

              {/* Info overlay at bottom */}
              <div className="absolute bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-6 pt-8 pb-6 md:px-8 md:pt-12 md:pb-8 space-y-3 max-h-[50vh] overflow-y-auto">
                {/* Prompt */}
                <p className="text-sm text-white/90 leading-relaxed max-w-4xl break-words">
                  {selectedItem.prompt}
                </p>

                {/* Details - Inline compact layout */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                  <div className="flex items-baseline gap-2">
                    <span className="text-white/50 uppercase tracking-wide">Model:</span>
                    <span className="text-white font-medium">{selectedItem.model}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-white/50 uppercase tracking-wide">Type:</span>
                    <span className="rounded-none bg-[#FF580020] border border-[#FF5800]/40 px-2 py-0.5 text-[#FF5800] font-bold uppercase">
                      {selectedItem.type}
                    </span>
                  </div>

                  <div className="flex items-baseline gap-2">
                    <span className="text-white/50 uppercase tracking-wide">Created:</span>
                    <span className="text-white font-medium">
                      {format(new Date(selectedItem.createdAt), "MMM d, yyyy")}
                    </span>
                  </div>

                  {selectedItem.dimensions && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-white/50 uppercase tracking-wide">Dimensions:</span>
                      <span className="text-white font-medium">
                        {selectedItem.dimensions.width} × {selectedItem.dimensions.height}
                      </span>
                    </div>
                  )}

                  {selectedItem.fileSize && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-white/50 uppercase tracking-wide">Size:</span>
                      <span className="text-white font-medium">
                        {(Number(selectedItem.fileSize) / 1024 / 1024).toFixed(2)} MB
                      </span>
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-2 pt-1">
                  <BrandButton
                    variant="outline"
                    size="sm"
                    onClick={() => handleDownload(selectedItem)}
                  >
                    <DownloadIcon className="w-4 h-4 mr-2" />
                    Download
                  </BrandButton>
                  <BrandButton
                    variant="outline"
                    size="sm"
                    className="border-rose-500/40 text-rose-400 hover:bg-rose-500/10"
                    onClick={() => {
                      setDeleteConfirmItem(selectedItem);
                      setSelectedItem(null);
                    }}
                  >
                    <TrashIcon className="w-4 h-4 mr-2" />
                    Delete
                  </BrandButton>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteConfirmItem}
        onOpenChange={(open) => !open && setDeleteConfirmItem(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Media</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this media? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {deleteConfirmItem && (
            <div className="py-4">
              <p className="text-sm text-white/70 line-clamp-3">{deleteConfirmItem.prompt}</p>
            </div>
          )}

          <DialogFooter>
            <BrandButton
              variant="outline"
              onClick={() => setDeleteConfirmItem(null)}
              disabled={isDeleting}
            >
              Cancel
            </BrandButton>
            <BrandButton
              variant="primary"
              onClick={() => deleteConfirmItem && handleDelete(deleteConfirmItem)}
              disabled={isDeleting}
              className="bg-rose-500 hover:bg-rose-600"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </BrandButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function GalleryGridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="overflow-hidden group cursor-pointer relative bg-black/60 aspect-square"
        >
          <Skeleton className="w-full h-full bg-white/10" />
        </div>
      ))}
    </div>
  );
}
