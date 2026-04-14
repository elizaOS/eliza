import { Check, Copy, Pencil, Trash2, Volume2 } from "lucide-react";

import { Button } from "../../ui/button";
import { PagePanel } from "../page-panel";
import type { ChatMessageLabels } from "./chat-types";

export interface ChatMessageActionsProps {
  canDelete?: boolean;
  canEdit?: boolean;
  canPlay?: boolean;
  copied?: boolean;
  labels?: ChatMessageLabels;
  onCopy?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  onPlay?: () => void;
}

export function ChatMessageActions({
  canDelete = false,
  canEdit = false,
  canPlay = false,
  copied = false,
  labels = {},
  onCopy,
  onDelete,
  onEdit,
  onPlay,
}: ChatMessageActionsProps) {
  const copyLabel = labels.copy ?? "Copy message";
  const copiedLabel = labels.copied ?? "Copied!";
  const copiedAriaLabel = labels.copiedAria ?? "Copied to clipboard";

  return (
    <PagePanel.ActionRail className="top-1 rounded-lg p-1">
      <Button
        variant="surface"
        size="icon"
        onClick={onCopy}
        className="h-8 w-8 rounded-lg"
        title={copied ? copiedLabel : copyLabel}
        aria-label={copied ? copiedAriaLabel : copyLabel}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-ok" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>

      {canPlay ? (
        <Button
          variant="surface"
          size="icon"
          onClick={onPlay}
          className="h-8 w-8 rounded-lg"
          title={labels.play ?? "Play message"}
          aria-label={labels.play ?? "Play message"}
        >
          <Volume2 className="h-3.5 w-3.5" />
        </Button>
      ) : null}

      {canEdit ? (
        <Button
          variant="surface"
          size="icon"
          onClick={onEdit}
          className="h-8 w-8 rounded-lg"
          title={labels.edit ?? "Edit message"}
          aria-label={labels.edit ?? "Edit message"}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      ) : null}

      {canDelete ? (
        <Button
          variant="surfaceDestructive"
          size="icon"
          onClick={onDelete}
          className="h-8 w-8 rounded-lg"
          title={labels.delete ?? "Delete message"}
          aria-label={labels.delete ?? "Delete message"}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </PagePanel.ActionRail>
  );
}
