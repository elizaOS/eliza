/**
 * Horizontal strip of pending attachment thumbnails shown above the chat
 * composer, each with a remove control. Image items render a preview tile;
 * audio/video/document items render a labelled icon tile.
 */
import { FileText, Film, Music } from "lucide-react";
import type * as React from "react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "../../ui/attachment";
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
    <AttachmentMedia className="h-16 w-16 flex-col gap-1 rounded-sm border border-border bg-bg/40 px-1 text-center">
      <Icon className="size-5 text-muted" />
      <AttachmentTitle
        className="w-full text-2xs font-normal text-muted"
        title={item.name}
      >
        {item.name}
      </AttachmentTitle>
    </AttachmentMedia>
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
    <AttachmentGroup
      className={`relative w-full gap-2 px-1.5 py-1.5 [--scroll-fade-size:1.5rem] ${
        variant === "game-modal" ? "pointer-events-auto" : ""
      }`}
      data-no-camera-drag={variant === "game-modal" || undefined}
      data-scroll-cert-scroller
      style={{ zIndex: 1 }}
    >
      {items.map((item, index) => (
        <Attachment
          key={item.id}
          size="xs"
          className="group h-16 w-16 min-w-16 overflow-visible rounded-sm border-0 bg-transparent p-0 has-data-[slot=attachment-media]:p-0"
        >
          {!item.kind || item.kind === "image" ? (
            <AttachmentMedia
              variant="image"
              className="h-16 w-16 rounded-sm border border-border bg-bg/40"
            >
              <img src={item.src} alt={item.alt} />
            </AttachmentMedia>
          ) : (
            <NonImageTile item={item} />
          )}
          <AttachmentActions className="absolute -right-1.5 -top-1.5">
            <AttachmentAction
              variant={
                variant === "game-modal" ? "surfaceDestructive" : "destructive"
              }
              size="icon"
              title={removeLabel(item)}
              aria-label={removeLabel(item)}
              onClick={() => onRemove(item.id, index)}
              className="h-4 w-4 rounded-sm text-2xs opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
            >
              ×
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}
