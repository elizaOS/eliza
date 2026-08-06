"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search, Clock } from "lucide-react";
import { useCommandRegistry } from "@/hooks/useCommandRegistry";
import { CommandPaletteItem } from "./CommandPaletteItem";
import { SHORTCUT_CATEGORIES } from "@/lib/shortcuts";
import type { Command, ShortcutCategory } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** Fuzzy match: every character of query must appear in order in target */
function fuzzyMatch(target: string, query: string): boolean {
  if (!query) return true;
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Score a command against a search query (higher = better) */
function score(cmd: Command, query: string): number {
  const q = query.toLowerCase();
  const label = cmd.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (label.includes(q)) return 60;
  if (cmd.description.toLowerCase().includes(q)) return 40;
  if (fuzzyMatch(label, q)) return 20;
  return 0;
}

interface GroupedResults {
  label: string;
  commands: Command[];
}

export function CommandPalette() {
  const {
    paletteOpen,
    closePalette,
    commands,
    runCommand,
    recentCommandIds,
    openHelp,
  } = useCommandRegistry();

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state when palette opens
  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setActiveIndex(0);
      // Small delay to let the dialog animate in before focusing
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [paletteOpen]);

  const filteredGroups = useMemo<GroupedResults[]>(() => {
    if (!query.trim()) {
      // Show recents first, then all categories
      const recentCmds = recentCommandIds
        .map((id) => commands.find((c) => c.id === id))
        .filter((c): c is Command => !!c);

      const groups: GroupedResults[] = [];
      if (recentCmds.length > 0) {
        groups.push({ label: "Recent", commands: recentCmds });
      }
      for (const cat of SHORTCUT_CATEGORIES) {
        const catCmds = commands.filter((c) => c.category === cat);
        if (catCmds.length > 0) {
          groups.push({ label: cat, commands: catCmds });
        }
      }
      return groups;
    }

    // Search mode: flat scored list, re-grouped by category
    const scored = commands
      .map((cmd) => ({ cmd, s: score(cmd, query) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ cmd }) => cmd);

    if (scored.length === 0) return [];

    const byCategory: Partial<Record<ShortcutCategory, Command[]>> = {};
    for (const cmd of scored) {
      if (!byCategory[cmd.category]) byCategory[cmd.category] = [];
      byCategory[cmd.category]!.push(cmd);
    }

    return SHORTCUT_CATEGORIES.filter((c) => byCategory[c]?.length).map(
      (c) => ({ label: c, commands: byCategory[c]! })
    );
  }, [query, commands, recentCommandIds]);

  const flatResults = useMemo(
    () => filteredGroups.flatMap((g) => g.commands),
    [filteredGroups]
  );

  // Clamp activeIndex when results change
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(flatResults.length - 1, 0)));
  }, [flatResults.length]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = flatResults[activeIndex];
      if (cmd) {
        closePalette();
        runCommand(cmd.id);
      }
    }
  };

  const handleSelect = (cmd: Command) => {
    closePalette();
    runCommand(cmd.id);
  };

  let flatIdx = 0;

  return (
    <Dialog.Root open={paletteOpen} onOpenChange={(open) => !open && closePalette()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-[20%] -translate-x-1/2 z-50",
            "w-full max-w-xl",
            "bg-surface-900 border border-surface-700 rounded-xl shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "data-[state=closed]:slide-out-to-left-1/2 data-[state=open]:slide-in-from-left-1/2",
            "data-[state=closed]:slide-out-to-top-[18%] data-[state=open]:slide-in-from-top-[18%]"
          )}
          onKeyDown={handleKeyDown}
          aria-label="Command palette"
        >
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-3 border-b border-surface-800">
            <Search className="w-4 h-4 text-surface-500 flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              placeholder="Search commands..."
              className={cn(
                "flex-1 bg-transparent text-sm text-surface-100",
                "placeholder:text-surface-500 focus:outline-none"
              )}
            />
            <kbd className="hidden sm:inline-flex items-center h-5 px-1.5 rounded text-[10px] font-mono bg-surface-800 border border-surface-700 text-surface-500">
              Esc
            </kbd>
          </div>

          {/* Results */}
          <div
            ref={listRef}
            role="listbox"
            className="overflow-y-auto max-h-[360px] py-1"
          >
            {filteredGroups.length === 0 ? (
              <div className="py-10 text-center text-sm text-surface-500">
                No commands found
              </div>
            ) : (
              filteredGroups.map((group) => (
                <div key={group.label}>
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    {group.label === "Recent" && (
                      <Clock className="w-3 h-3 text-surface-600" />
                    )}
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-surface-600">
                      {group.label}
                    </span>
                  </div>
                  {group.commands.map((cmd) => {
                    const idx = flatIdx++;
                    return (
                      <div key={cmd.id} data-index={idx}>
                        <CommandPaletteItem
                          command={cmd}
                          isActive={idx === activeIndex}
                          onSelect={() => handleSelect(cmd)}
                          onHighlight={() => setActiveIndex(idx)}
                        />
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-4 px-3 py-2 border-t border-surface-800 text-[10px] text-surface-600">
            <span className="flex items-center gap-1">
              <kbd className="inline-flex items-center h-4 px-1 rounded bg-surface-800 border border-surface-700 font-mono">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="inline-flex items-center h-4 px-1 rounded bg-surface-800 border border-surface-700 font-mono">↵</kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="inline-flex items-center h-4 px-1 rounded bg-surface-800 border border-surface-700 font-mono">Esc</kbd>
              close
            </span>
            <button
              onClick={() => { closePalette(); openHelp(); }}
              className="ml-auto hover:text-surface-300 transition-colors"
            >
              ? View all shortcuts
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
