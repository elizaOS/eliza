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
  AttachmentContent,
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
    <>
      <AttachmentMedia>
        <Icon className="size-5 text-muted" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={item.name}>{item.name}</AttachmentTitle>
      </AttachmentContent>
    </>
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
      className={
        variant === "game-modal" ? "z-[1] pointer-events-auto" : "z-[1]"
      }
      data-no-camera-drag={variant === "game-modal" || undefined}
    >
      {items.map((item, index) => (
        <Attachment key={item.id} orientation="vertical" size="xs">
          {!item.kind || item.kind === "image" ? (
            <AttachmentMedia variant="image">
              <img src={item.src} alt={item.alt} />
            </AttachmentMedia>
          ) : (
            <NonImageTile item={item} />
          )}
          <AttachmentActions>
            <AttachmentAction
              variant={
                variant === "game-modal" ? "surfaceDestructive" : "destructive"
              }
              size="icon-sm"
              title={removeLabel(item)}
              aria-label={removeLabel(item)}
              onClick={() => onRemove(item.id, index)}
            >
              ×
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}
