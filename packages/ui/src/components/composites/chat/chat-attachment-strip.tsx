/**
 * Horizontal strip of pending attachment thumbnails shown above the chat
 * composer, each with a remove control. Image items render a preview tile;
 * audio/video/document items render a labelled icon tile.
 */
import { FileText, Film, Music } from "lucide-react";
import type * as React from "react";
import { Button } from "../../ui/button";
import type { ChatAttachmentItem, ChatVariant } from "./chat-types";

export interface ChatAttachmentStripProps {
  items: ChatAttachmentItem[];
  onRemove: (id: string, index: number) => void;
  removeLabel?: (item: ChatAttachmentItem) => string;
  variant?: ChatVariant;
}

function NonImageTile({
  item,
}: {
  item: ChatAttachmentItem;
}): React.JSX.Element {
  const Icon =
    item.kind === "audio" ? Music : item.kind === "video" ? Film : FileText;
  return (
    <div className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-sm border border-border bg-bg/40 px-1 text-center">
      <Icon className="h-5 w-5 text-muted" />
      <span className="w-full truncate text-2xs text-muted" title={item.name}>
        {item.name}
      </span>
    </div>
  );
}

export function ChatAttachmentStrip({
  items,
  onRemove,
  removeLabel = (item) => `Remove ${item.name}`,
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
          {!item.kind || item.kind === "image" ? (
            <img
              src={item.src}
              alt={item.alt}
              className="h-16 w-16 rounded-sm border border-border object-cover"
            />
          ) : (
            <NonImageTile item={item} />
          )}
          <Button
            variant={
              variant === "game-modal" ? "surfaceDestructive" : "destructive"
            }
            size="icon"
            title={removeLabel(item)}
            aria-label={removeLabel(item)}
            onClick={() => onRemove(item.id, index)}
            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-sm text-2xs opacity-100 transition-opacity  sm:opacity-0 sm:group-hover:opacity-100"
          >
            ×
          </Button>
        </div>
      ))}
    </div>
  );
}
