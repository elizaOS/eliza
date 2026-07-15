/**
 * ProviderPicker — the command-palette-style provider chooser inside the
 * Add Account dialog. Raycast/Cursor benchmark: a single searchable, fully
 * keyboard-navigable list with brand marks, ONE calm capability line per row,
 * and no dead space.
 *
 * Keyboard: type to filter, ArrowUp/Down to move the highlight, Enter to pick,
 * Escape bubbles to the dialog. The highlighted row scrolls into view. Rows
 * are grouped by category (Chat providers / Coding subscriptions) but the
 * search + arrow navigation flow across the whole flattened list so the
 * keyboard never gets trapped in a group.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { Search } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import {
  ACCOUNT_PROVIDER_OPTIONS,
  type AccountProviderCategory,
  type AccountProviderOption,
} from "./account-provider-options";
import { ProviderMark } from "./provider-icons";

interface ProviderPickerProps {
  onPick: (providerId: LinkedAccountProviderId) => void;
}

const CATEGORY_ORDER: AccountProviderCategory[] = ["coding", "chat"];

const CATEGORY_LABEL: Record<AccountProviderCategory, string> = {
  coding: "Subscriptions",
  chat: "API keys",
  local: "Local",
  cloud: "Cloud",
};

/** One short capability line, not a pill row (kills the tag maze). */
function capabilityLine(option: AccountProviderOption): string {
  if (option.unavailable) return "Not available to link here";
  if (option.category === "chat") return "Chat · bring your own API key";
  if (option.id === "anthropic-subscription")
    return "Chat + coding agents · browser login";
  if (option.id === "gemini-cli")
    return "Coding agents · third-party CLI login";
  const usesKey = option.id === "zai-coding" || option.id === "kimi-coding";
  return usesKey
    ? "Coding agents · dedicated plan key"
    : "Coding agents · browser login";
}

export function ProviderPicker({ onPick }: ProviderPickerProps) {
  const t = useAppSelector((s) => s.t);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Flattened, filtered, category-ordered list. Search matches name +
  // description so "claude", "key", "gpt" all resolve.
  const flat = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items: AccountProviderOption[] = [];
    for (const category of CATEGORY_ORDER) {
      for (const option of ACCOUNT_PROVIDER_OPTIONS) {
        if (option.category !== category) continue;
        if (
          q &&
          !option.name.toLowerCase().includes(q) &&
          !option.description.toLowerCase().includes(q)
        ) {
          continue;
        }
        items.push(option);
      }
    }
    return items;
  }, [query]);

  // Keep the highlight in range as the filter narrows.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % Math.max(1, flat.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + flat.length) % Math.max(1, flat.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = flat[activeIndex];
      if (option) onPick(option.id);
    }
  };

  // Group boundaries for section headers, computed from the flat order.
  let lastCategory: AccountProviderCategory | null = null;

  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("accounts.add.search", {
            defaultValue: "Search providers",
          })}
          className="h-9 w-full rounded-md border border-border/60 bg-bg-accent/40 pl-8 pr-3 text-sm text-txt-strong outline-none placeholder:text-muted"
          aria-label={t("accounts.add.search", {
            defaultValue: "Search providers",
          })}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div
        ref={listRef}
        className="max-h-[min(52vh,420px)] overflow-y-auto"
        role="listbox"
        aria-label={t("accounts.add.chooseTitle", {
          defaultValue: "Add a provider account",
        })}
      >
        {flat.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted">
            {t("accounts.add.noMatch", {
              defaultValue: "No providers match your search.",
            })}
          </p>
        ) : (
          flat.map((option, index) => {
            const showHeader = option.category !== lastCategory;
            lastCategory = option.category;
            const active = index === activeIndex;
            return (
              <div key={option.id}>
                {showHeader ? (
                  <div className="px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted first:pt-0">
                    {CATEGORY_LABEL[option.category]}
                  </div>
                ) : null}
                <button
                  type="button"
                  data-index={index}
                  role="option"
                  aria-selected={active}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => onPick(option.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                    active ? "bg-bg-accent" : "hover:bg-bg-accent/60",
                    option.unavailable && "opacity-60",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
                      active
                        ? "border-txt/25 bg-card text-txt-strong"
                        : "border-border/50 bg-bg-accent/60 text-muted-strong",
                    )}
                  >
                    <ProviderMark
                      providerId={option.id}
                      className="h-4 w-4"
                      title={option.name}
                    />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-txt-strong">
                      {option.name}
                    </span>
                    <span className="truncate text-[11px] text-muted">
                      {capabilityLine(option)}
                    </span>
                  </span>
                  {active ? (
                    <kbd className="shrink-0 rounded border border-border/50 bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted">
                      {t("accounts.add.enterHint", { defaultValue: "\u21b5" })}
                    </kbd>
                  ) : null}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
