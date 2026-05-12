import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { Pencil } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

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
      <form onSubmit={submit} className="min-w-0 flex-1">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void submit()}
          onKeyDown={handleKeyDown}
          autoFocus
          disabled={disabled}
          className={cn("h-7 max-w-[240px] text-sm", inputClassName)}
          aria-label={inputAriaLabel}
        />
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) setEditing(true);
      }}
      disabled={disabled}
      title={editTitle}
      className={cn(
        "group inline-flex min-w-0 items-center gap-1 truncate rounded text-sm font-medium text-txt hover:text-accent disabled:cursor-not-allowed disabled:hover:text-txt",
        className,
      )}
    >
      <span className="truncate">{value}</span>
      <Pencil
        className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      />
    </button>
  );
}
