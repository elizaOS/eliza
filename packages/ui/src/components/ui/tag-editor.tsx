/**
 * TagEditor — add/remove string tags with chip display.
 *
 * Fully generic; no app-context dependency. Callers pass translated labels
 * via props (with English defaults so the component works out-of-the-box).
 */

import { useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Input } from "./input";

export interface TagEditorProps {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  /** Label for the Add button. Defaults to "Add". */
  addLabel?: string;
  /** Label for the remove button. Defaults to "×". */
  removeLabel?: string;
  /** Optional class for the root container. */
  className?: string;
  /** Optional class for the input row. */
  inputRowClassName?: string;
  /** Optional class for the scrollable tag list. */
  listClassName?: string;
}

export function TagEditor({
  label,
  items,
  onChange,
  placeholder = "add item...",
  addLabel = "+",
  removeLabel = "×",
  className,
  inputRowClassName,
  listClassName,
}: TagEditorProps) {
  const [inputValue, setInputValue] = useState("");

  const addItem = () => {
    const trimmed = inputValue.trim();
    if (trimmed && !items.includes(trimmed)) {
      onChange([...items, trimmed]);
    }
    setInputValue("");
  };

  const removeItem = (index: number) => {
    const updated = [...items];
    updated.splice(index, 1);
    onChange(updated);
  };

  return (
    <div className={cn("flex min-h-0 flex-col gap-1.5", className)}>
      <span className="font-semibold text-xs">{label}</span>
      <div className={cn("flex items-center gap-1.5", inputRowClassName)}>
        <Input
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
          className="h-7 px-2 border-border bg-card text-[11px] focus-visible:ring-1 focus-visible:ring-accent flex-1 min-w-0 shadow-sm"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 text-[14px] p-0 text-accent border-none hover:bg-transparent hover:text-accent/80 font-bold"
          onClick={addItem}
        >
          {addLabel}
        </Button>
      </div>
      <div
        className={cn(
          "min-h-0 overflow-y-auto rounded-xl border border-border/40 bg-bg/50 p-2 backdrop-blur-sm",
          "flex flex-wrap content-start items-start gap-x-1.5 gap-y-1",
          listClassName,
        )}
      >
        {items.map((item, i) => (
          <span
            key={item}
            className="inline-flex items-center justify-between gap-1 px-2 py-0.5 border border-border/50 bg-black/10 rounded text-[11px] h-fit text-txt font-medium"
          >
            <span className="truncate max-w-[200px]" title={item}>
              {item}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-4 w-4 p-0 text-danger/80 hover:text-danger hover:bg-transparent"
              onClick={() => removeItem(i)}
            >
              {removeLabel}
            </Button>
          </span>
        ))}
      </div>
    </div>
  );
}
