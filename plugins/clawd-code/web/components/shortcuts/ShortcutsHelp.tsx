"use client";

import { useState, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Search } from "lucide-react";
import { useCommandRegistry } from "@/hooks/useCommandRegistry";
import { ShortcutBadge } from "./ShortcutBadge";
import { SHORTCUT_CATEGORIES } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

export function ShortcutsHelp() {
  const { helpOpen, closeHelp, commands } = useCommandRegistry();
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const q = filter.toLowerCase();
    return SHORTCUT_CATEGORIES.map((cat) => ({
      category: cat,
      commands: commands.filter(
        (c) =>
          c.category === cat &&
          c.keys.length > 0 &&
          (!q ||
            c.label.toLowerCase().includes(q) ||
            c.description.toLowerCase().includes(q))
      ),
    })).filter((g) => g.commands.length > 0);
  }, [commands, filter]);

  return (
    <Dialog.Root open={helpOpen} onOpenChange={(open) => !open && closeHelp()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50",
            "w-full max-w-2xl max-h-[80vh] flex flex-col",
            "bg-surface-900 border border-surface-700 rounded-xl shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800 flex-shrink-0">
            <div>
              <Dialog.Title className="text-sm font-semibold text-surface-100">
                Keyboard Shortcuts
              </Dialog.Title>
              <Dialog.Description className="text-xs text-surface-500 mt-0.5">
                Press <kbd className="inline-flex items-center h-4 px-1 rounded bg-surface-800 border border-surface-700 text-[10px] font-mono">?</kbd> anytime to open this panel
              </Dialog.Description>
            </div>
            <Dialog.Close className="p-1.5 rounded-md text-surface-500 hover:text-surface-100 hover:bg-surface-800 transition-colors">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          {/* Search */}
          <div className="px-4 py-2.5 border-b border-surface-800 flex-shrink-0">
            <div className="flex items-center gap-2 bg-surface-800 rounded-lg px-3 py-1.5">
              <Search className="w-3.5 h-3.5 text-surface-500 flex-shrink-0" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter shortcuts..."
                className="flex-1 bg-transparent text-sm text-surface-100 placeholder:text-surface-500 focus:outline-none"
                autoFocus
              />
            </div>
          </div>

          {/* Shortcut groups */}
          <div className="overflow-y-auto flex-1 px-4 py-3 space-y-5">
            {groups.length === 0 ? (
              <p className="text-center text-sm text-surface-500 py-8">
                No shortcuts found
              </p>
            ) : (
              groups.map(({ category, commands: cmds }) => (
                <div key={category}>
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-surface-600 mb-2">
                    {category}
                  </h3>
                  <div className="rounded-lg border border-surface-800 overflow-hidden divide-y divide-surface-800">
                    {cmds.map((cmd) => (
                      <div
                        key={cmd.id}
                        className="flex items-center justify-between px-3 py-2 hover:bg-surface-800/50 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-surface-200">{cmd.label}</p>
                          {cmd.description && (
                            <p className="text-xs text-surface-500 mt-0.5">{cmd.description}</p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1 ml-4 flex-shrink-0">
                          {cmd.keys.map((k) => (
                            <ShortcutBadge key={k} keys={[k]} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
