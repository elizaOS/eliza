// biome-ignore lint/correctness/noUnusedImports: Required for this package's JSX transform in tests.
import * as React from "react";
import { Button } from "../../ui/button";
import type { ChatAttachmentItem, ChatVariant } from "./chat-types";

export interface ChatAttachmentStripProps {
  items: ChatAttachmentItem[];
  onRemove: (id: string, index: number) => void;
  removeLabel?: (item: ChatAttachmentItem) => string;
  variant?: ChatVariant;
}

export function ChatAttachmentStrip({
  items,
  onRemove,
  removeLabel = (item) => `Remove image ${item.name}`,
  variant = "default",
}: ChatAttachmentStripProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div
      className={`relative flex flex-wrap gap-2 py-1 ${
        variant === "game-modal" ? "pointer-events-auto" : ""
      }`}
      data-no-camera-drag={variant === "game-modal" || undefined}
      style={{ zIndex: 1 }}
    >
      {items.map((item, index) => (
        <div key={item.id} className="relative h-16 w-16 shrink-0 group">
          <img
            src={item.src}
            alt={item.alt}
            className="h-16 w-16 rounded border border-border object-cover"
          />
          <Button
            variant={
              variant === "game-modal" ? "surfaceDestructive" : "destructive"
            }
            size="icon"
            title={removeLabel(item)}
            aria-label={removeLabel(item)}
            onClick={() => onRemove(item.id, index)}
            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-2xs opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          >
            ×
          </Button>
        </div>
      ))}
    </div>
  );
}
