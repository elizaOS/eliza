import { Sparkles } from "lucide-react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";

export interface ChatConversationRenameDialogProps {
  cancelLabel?: string;
  description: string;
  inputLabel: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  onSuggest?: () => void | Promise<void>;
  open: boolean;
  saving?: boolean;
  saveLabel: string;
  saveDisabled?: boolean;
  savePendingLabel?: string;
  suggesting?: boolean;
  suggestDisabled?: boolean;
  suggestLabel?: string;
  suggestPendingLabel?: string;
  title: string;
  value: string;
}

export function ChatConversationRenameDialog({
  cancelLabel = "Cancel",
  description,
  inputLabel,
  onChange,
  onClose,
  onSave,
  onSuggest,
  open,
  saving = false,
  saveLabel,
  savePendingLabel = saveLabel,
  saveDisabled = false,
  suggesting = false,
  suggestDisabled = false,
  suggestLabel = "Suggest",
  suggestPendingLabel = suggestLabel,
  title,
  value,
}: ChatConversationRenameDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => !nextOpen && onClose()}
    >
      <DialogContent
        data-testid="conv-rename-dialog"
        className="max-w-md"
        onPointerDownOutside={onClose}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-1">
          <Label htmlFor="conv-rename-title-input">{inputLabel}</Label>
          <Input
            id="conv-rename-title-input"
            data-testid="conv-rename-input"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onSave();
              }
            }}
            disabled={saveDisabled || suggestDisabled}
            className="text-txt"
          />
        </div>

        <DialogFooter className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {onSuggest ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="conv-rename-suggest"
              className="gap-1.5 border-border"
              onClick={() => void onSuggest()}
              disabled={suggestDisabled || saveDisabled}
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {suggesting ? suggestPendingLabel : suggestLabel}
            </Button>
          ) : (
            <div />
          )}
          <div className="flex w-full justify-end gap-2 sm:w-auto">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="conv-rename-cancel"
              onClick={onClose}
            >
              {cancelLabel}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="conv-rename-save"
              onClick={() => void onSave()}
              disabled={saveDisabled}
            >
              {saving ? savePendingLabel : saveLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
