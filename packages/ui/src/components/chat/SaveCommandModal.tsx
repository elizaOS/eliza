import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@elizaos/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useApp } from "../../state";

interface SaveCommandModalProps {
  open: boolean;
  text: string;
  onSave: (name: string) => void;
  onClose: () => void;
}

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/;

export function SaveCommandModal({
  open,
  text,
  onSave,
  onClose,
}: SaveCommandModalProps) {
  const { t } = useApp();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const inputLabelId = useId();
  const inputErrorId = useId();

  useEffect(() => {
    if (open) {
      setName("");
      setError("");
      const focusTimeout = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(focusTimeout);
    }
  }, [open]);

  const validate = useCallback(
    (value: string) => {
      if (!value) return t("savecommandmodal.nameRequired");
      if (!NAME_PATTERN.test(value)) return t("savecommandmodal.nameFormat");
      return "";
    },
    [t],
  );

  const handleSubmit = useCallback(() => {
    const err = validate(name);
    if (err) {
      setError(err);
      return;
    }
    onSave(name);
  }, [name, validate, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit],
  );

  const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="w-full max-w-md p-0 overflow-hidden rounded-xl">
        <DialogHeader className="px-5 py-3 shrink-0">
          <DialogTitle className="font-bold text-sm">
            {t("savecommandmodal.SaveAsCommand")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("savecommandmodal.CommandName")}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 flex flex-col gap-3">
          <label
            id={inputLabelId}
            htmlFor={inputId}
            className="text-xs text-muted"
          >
            {t("savecommandmodal.CommandName")}
          </label>
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted">/</span>
            <Input
              id={inputId}
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              onKeyDown={handleKeyDown}
              placeholder={t("savecommandmodal.myCommand")}
              aria-labelledby={inputLabelId}
              aria-describedby={error ? inputErrorId : undefined}
              aria-invalid={error ? "true" : undefined}
              className="flex-1 h-8 text-sm shadow-sm"
              style={{
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: "var(--text)",
              }}
            />
          </div>
          {error && (
            <p
              id={inputErrorId}
              className="text-xs"
              style={{ color: "#ef4444" }}
            >
              {error}
            </p>
          )}

          <span className="text-xs mt-1 text-muted">{t("common.preview")}</span>
          <pre
            className="text-xs px-3 py-2 whitespace-pre-wrap break-words max-h-24 overflow-y-auto rounded-lg"
            style={{
              color: "var(--muted)",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
            }}
          >
            {preview}
          </pre>
        </div>

        <DialogFooter className="px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="default" size="sm" onClick={handleSubmit}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
