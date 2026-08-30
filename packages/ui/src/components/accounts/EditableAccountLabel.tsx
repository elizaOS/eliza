/**
 * Click-to-edit label used for an account's display name inside `AccountCard`.
 * Shows the value with a pencil affordance; entering edit mode swaps in an
 * inline input that commits on Enter/blur and reverts on Escape. Persistence is
 * the caller's — `onSubmit(label)` may be async; an empty, unchanged, or
 * rejected value reverts to the previous label.
 */

import { Pencil } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SemanticForm } from "../ui/semantic-form";

export interface EditableAccountLabelProps {
  value: string;
  onSubmit: (label: string) => Promise<void> | void;
  disabled?: boolean;
  inputAriaLabel?: string;
  editTitle?: string;
  className?: string;
  inputClassName?: string;
}

export function EditableAccountLabel({
  value,
  onSubmit,
  disabled = false,
  inputAriaLabel = "Account label",
  editTitle = "Click to rename",
  className,
  inputClassName,
}: EditableAccountLabelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const submit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const trimmed = draft.trim();
      setEditing(false);
      if (!trimmed || trimmed === value) {
        setDraft(value);
        return;
      }
      try {
        await onSubmit(trimmed);
      } catch {
        setDraft(value);
      }
    },
    [draft, onSubmit, value],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(value);
      setEditing(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  };

  if (editing) {
    return (
      <SemanticForm onSubmit={submit} className="min-w-0 flex-1">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void submit()}
          onKeyDown={handleKeyDown}
          autoFocus
          disabled={disabled}
          density="compact"
          className={cn("max-w-[240px]", inputClassName)}
          aria-label={inputAriaLabel}
        />
      </SemanticForm>
    );
  }

  return (
    <Button
      variant="mediaZoom"
      size="content"
      onClick={() => {
        if (!disabled) setEditing(true);
      }}
      disabled={disabled}
      title={editTitle}
      className={cn("min-w-0 truncate", className)}
    >
      <span className="truncate">{value}</span>
      <Pencil className="size-3 shrink-0 opacity-60" aria-hidden />
    </Button>
  );
}
