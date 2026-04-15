import { ChevronDown } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Z_MODAL } from "../../lib/floating-layers";
import { Button } from "./button";

export interface ThemedSelectGroup<T extends string = string> {
  label: string;
  items: { id: T; text: string; hint?: string }[];
}

export interface ThemedSelectProps<T extends string = string> {
  value: T | null;
  groups: ThemedSelectGroup<T>[];
  onChange: (id: T) => void;
  placeholder?: string;
  menuPlacement?: "top" | "bottom";
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}

type SelectOption<T extends string> = {
  id: T;
  text: string;
  hint?: string;
  groupLabel: string;
};

export function ThemedSelect<T extends string>({
  value,
  groups,
  onChange,
  placeholder = "Select…",
  menuPlacement = "bottom",
  className = "",
  triggerClassName = "",
  menuClassName = "",
  ariaLabel,
  ariaLabelledBy,
}: ThemedSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const triggerId = useId();
  const listboxId = useId();

  const options = useMemo<SelectOption<T>[]>(
    () =>
      groups.flatMap((group) =>
        group.items.map((item) => ({
          ...item,
          groupLabel: group.label,
        })),
      ),
    [groups],
  );

  const selectedIndex = value
    ? options.findIndex((option) => option.id === value)
    : -1;
  const selectedItem = selectedIndex >= 0 ? options[selectedIndex] : null;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
      return;
    }

    const nextIndex =
      highlightedIndex >= 0
        ? highlightedIndex
        : selectedIndex >= 0
          ? selectedIndex
          : 0;
    setHighlightedIndex(nextIndex);
    optionRefs.current[nextIndex]?.focus();
  }, [highlightedIndex, open, selectedIndex]);

  const moveHighlight = (direction: 1 | -1) => {
    if (options.length === 0) return;
    const baseIndex =
      highlightedIndex >= 0
        ? highlightedIndex
        : selectedIndex >= 0
          ? selectedIndex
          : 0;
    const nextIndex = (baseIndex + direction + options.length) % options.length;
    setHighlightedIndex(nextIndex);
  };

  const commitSelection = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.id);
    setOpen(false);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (!open) setOpen(true);
        setHighlightedIndex(
          selectedIndex >= 0
            ? selectedIndex
            : event.key === "ArrowUp"
              ? options.length - 1
              : 0,
        );
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        setOpen((prev) => !prev);
        break;
      default:
        break;
    }
  };

  const handleOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveHighlight(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveHighlight(-1);
        break;
      case "Home":
        event.preventDefault();
        setHighlightedIndex(0);
        break;
      case "End":
        event.preventDefault();
        setHighlightedIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commitSelection(index);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={`relative min-w-0 w-full ${open ? `z-[${Z_MODAL}]` : ""} ${className}`}
    >
      <Button
        ref={triggerRef}
        id={triggerId}
        type="button"
        variant="outline"
        size="sm"
        role="combobox"
        aria-autocomplete="none"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={`flex h-12 w-full items-center justify-between border-border bg-card px-2.5 py-1.5 text-left text-xs shadow-sm hover:border-accent focus-visible:ring-1 focus-visible:ring-accent ${triggerClassName}`}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="truncate">
          {selectedItem
            ? `${selectedItem.text}${selectedItem.hint ? ` — ${selectedItem.hint}` : ""}`
            : placeholder}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`ml-2 h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </Button>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-labelledby={ariaLabelledBy}
          className={`absolute left-0 right-0 z-50 max-h-[280px] overflow-y-auto rounded-md border border-border bg-card shadow-lg ${
            menuPlacement === "top"
              ? "bottom-[calc(100%+0.125rem)]"
              : "top-[calc(100%+0.125rem)]"
          } ${menuClassName}`}
        >
          {groups.map((group) => (
            <div key={group.label}>
              <div className="sticky top-0 bg-bg-accent px-2.5 py-1 text-2xs font-semibold text-muted">
                {group.label}
              </div>
              {group.items.map((item) => {
                const optionIndex = options.findIndex(
                  (option) => option.id === item.id,
                );
                const active = item.id === value;
                const highlighted = optionIndex === highlightedIndex;

                return (
                  <button
                    key={item.id}
                    ref={(node) => {
                      optionRefs.current[optionIndex] = node;
                    }}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs ${
                      active
                        ? "bg-accent/18 text-accent"
                        : highlighted
                          ? "bg-accent/12 text-txt"
                          : "text-txt hover:bg-accent/10 hover:text-txt"
                    }`}
                    onClick={() => commitSelection(optionIndex)}
                    onKeyDown={(event) =>
                      handleOptionKeyDown(event, optionIndex)
                    }
                  >
                    <span className="min-w-0 truncate font-semibold">
                      {item.text}
                    </span>
                    {item.hint ? (
                      <span
                        className={`min-w-0 truncate ${
                          active ? "text-accent/80" : "text-muted"
                        }`}
                      >
                        {item.hint}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
