import { X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";

export interface TagEditorProps {
  items: string[];
  onChange: (items: string[]) => void;
  label?: string;
  placeholder?: string;
  className?: string;
  maxItems?: number;
  addLabel?: string;
  removeLabel?: string;
}

function normalizeTagValue(value: string) {
  return value.trim();
}

export function TagEditor({
  items,
  onChange,
  label,
  placeholder = "Add a tag...",
  className,
  maxItems,
  addLabel = "Add",
  removeLabel = "Remove",
}: TagEditorProps) {
  const [draft, setDraft] = useState("");

  const normalizedItems = useMemo(
    () => items.map((item) => normalizeTagValue(item)).filter(Boolean),
    [items],
  );
  const itemSet = useMemo(
    () => new Set(normalizedItems.map((item) => item.toLowerCase())),
    [normalizedItems],
  );
  const canAddMore =
    typeof maxItems !== "number" || normalizedItems.length < maxItems;

  const commitDraft = useCallback(() => {
    const next = normalizeTagValue(draft);
    if (!next || !canAddMore || itemSet.has(next.toLowerCase())) {
      setDraft("");
      return;
    }

    onChange([...normalizedItems, next]);
    setDraft("");
  }, [canAddMore, draft, itemSet, normalizedItems, onChange]);

  const removeItem = useCallback(
    (item: string) => {
      onChange(normalizedItems.filter((candidate) => candidate !== item));
    },
    [normalizedItems, onChange],
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {label ? <Label>{label}</Label> : null}

      <div className="flex flex-wrap gap-2">
        {normalizedItems.map((item) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-bg-accent px-2.5 py-1 text-xs text-txt"
          >
            <span>{item}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-4 w-4 rounded-full text-muted hover:text-txt"
              aria-label={`${removeLabel} ${item}`}
              onClick={() => removeItem(item)}
            >
              <X className="h-3 w-3" />
            </Button>
          </span>
        ))}
      </div>

      <Input
        aria-label={label ?? addLabel}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== ",") return;
          event.preventDefault();
          commitDraft();
        }}
        onBlur={commitDraft}
        placeholder={canAddMore ? placeholder : "Tag limit reached"}
        disabled={!canAddMore}
      />
    </div>
  );
}
