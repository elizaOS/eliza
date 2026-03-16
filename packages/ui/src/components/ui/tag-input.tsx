import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

export interface TagInputProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Label shown above the input */
  label?: string;
  /** Current list of tags */
  items: string[];
  /** Called with the updated tag list */
  onChange: (items: string[]) => void;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Maximum number of tags */
  maxItems?: number;
  /** Label for the explicit add button */
  addLabel?: string;
  /** Aria-label template for the remove button */
  removeLabel?: string;
}

export const TagInput = React.forwardRef<HTMLDivElement, TagInputProps>(
  (
    {
      label,
      items,
      onChange,
      placeholder = "Add item…",
      maxItems,
      addLabel = "Add",
      removeLabel = "Remove",
      className,
      ...props
    },
    ref,
  ) => {
    const [inputValue, setInputValue] = React.useState("");

    const addItem = React.useCallback(() => {
      const trimmed = inputValue.trim();
      if (!trimmed || items.includes(trimmed)) return;
      if (maxItems != null && items.length >= maxItems) return;
      onChange([...items, trimmed]);
      setInputValue("");
    }, [inputValue, items, onChange, maxItems]);

    const removeItem = React.useCallback(
      (index: number) => {
        const updated = [...items];
        updated.splice(index, 1);
        onChange(updated);
      },
      [items, onChange],
    );

    return (
      <div
        ref={ref}
        className={cn("flex flex-col gap-1.5", className)}
        {...props}
      >
        {label && <span className="text-xs font-semibold">{label}</span>}
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={inputValue}
            placeholder={placeholder}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addItem();
              }
            }}
            className="flex-1 min-w-0 rounded-md border border-input bg-bg px-2 py-1 text-[11px] placeholder:text-muted focus-visible:outline-none focus-visible:border-ring"
          />
          <button
            type="button"
            className="rounded-md border border-input bg-bg px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-accent hover:text-accent"
            onClick={addItem}
          >
            {addLabel}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 rounded-md border border-border bg-bg-accent p-1.5 min-h-[60px] content-start">
          {items.map((item, i) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 rounded-sm border border-border bg-bg px-2 py-0.5 text-[11px]"
            >
              {item}
              <button
                type="button"
                className="text-muted hover:text-destructive transition-colors"
                onClick={() => removeItem(i)}
                aria-label={`${removeLabel} ${item}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      </div>
    );
  },
);
TagInput.displayName = "TagInput";
