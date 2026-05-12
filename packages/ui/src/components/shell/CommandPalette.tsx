import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { isElectrobunRuntime } from "../../bridge";
import {
  buildCommands as buildCommandPaletteCommands,
  type CommandItem,
} from "../../chat";
import { COMMAND_PALETTE_EVENT } from "../../events";
import { useBugReport } from "../../hooks";
import { useApp } from "../../state";
import {
  openDesktopSettingsWindow,
  openDesktopSurfaceWindow,
  requestDesktopBridge,
} from "../../utils";

export function CommandPalette() {
  const {
    commandPaletteOpen,
    commandQuery,
    commandActiveIndex,
    agentStatus,
    handleStart,
    handleStop,
    handleRestart,
    setTab,
    loadPlugins,
    loadSkills,
    loadLogs,
    loadWorkbench,
    handleChatClear,
    activeGameViewerUrl,
    setState,
    t,
  } = useApp();
  const { open: openBugReport } = useBugReport();
  const closeCommandPalette = useCallback(
    () => setState("commandPaletteOpen", false),
    [setState],
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = "command-palette-results";

  const agentState = agentStatus?.state ?? "stopped";
  const currentGameViewerUrl =
    typeof activeGameViewerUrl === "string" ? activeGameViewerUrl : "";
  const desktopRuntime = isElectrobunRuntime();

  const allCommands = useMemo<CommandItem[]>(() => {
    return buildCommandPaletteCommands({
      agentState,
      activeGameViewerUrl: currentGameViewerUrl,
      handleStart,
      handleStop,
      handleRestart,
      setTab,
      setAppsSubTab: () => setState("appsSubTab", "games"),
      loadPlugins,
      loadSkills,
      loadLogs,
      loadWorkbench,
      handleChatClear,
      openBugReport,
      desktopRuntime,
      focusDesktopMainWindow: () => {
        void requestDesktopBridge<void>(
          "desktopFocusWindow",
          "desktop:focusWindow",
        );
      },
      openDesktopSettingsWindow: (tabHint?: string) => {
        void openDesktopSettingsWindow(tabHint);
      },
      openDesktopSurfaceWindow: (surface, options) => {
        void openDesktopSurfaceWindow(surface, options);
      },
    });
  }, [
    agentState,
    currentGameViewerUrl,
    handleStart,
    handleStop,
    handleRestart,
    setTab,
    setState,
    loadPlugins,
    loadSkills,
    loadLogs,
    loadWorkbench,
    handleChatClear,
    openBugReport,
    desktopRuntime,
  ]);

  // Filter commands by query
  const filteredCommands = useMemo(() => {
    if (!commandQuery.trim()) return allCommands;
    const query = commandQuery.toLowerCase();
    return allCommands.filter((cmd) => cmd.label.toLowerCase().includes(query));
  }, [allCommands, commandQuery]);

  // Listen for elizaos:command-palette from main.tsx (desktop shortcut Cmd/Ctrl+K)
  useEffect(() => {
    const toggle = () => {
      setState("commandPaletteOpen", !commandPaletteOpen);
      if (!commandPaletteOpen) {
        setState("commandQuery", "");
        setState("commandActiveIndex", 0);
      }
    };
    document.addEventListener(COMMAND_PALETTE_EVENT, toggle);
    return () => document.removeEventListener(COMMAND_PALETTE_EVENT, toggle);
  }, [commandPaletteOpen, setState]);

  // Also listen for Ctrl/Meta+K in the browser (non-native context)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setState("commandPaletteOpen", !commandPaletteOpen);
        if (!commandPaletteOpen) {
          setState("commandQuery", "");
          setState("commandActiveIndex", 0);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteOpen, setState]);

  // Auto-focus input when opened
  useEffect(() => {
    if (commandPaletteOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [commandPaletteOpen]);

  useEffect(() => {
    if (filteredCommands.length === 0) {
      if (commandActiveIndex !== 0) {
        setState("commandActiveIndex", 0);
      }
      return;
    }

    const maxIndex = filteredCommands.length - 1;
    if (commandActiveIndex < 0 || commandActiveIndex > maxIndex) {
      setState(
        "commandActiveIndex",
        Math.min(Math.max(commandActiveIndex, 0), maxIndex),
      );
    }
  }, [commandActiveIndex, filteredCommands.length, setState]);

  // Reset active index when query changes
  useEffect(() => {
    if (commandQuery !== "") {
      setState("commandActiveIndex", 0);
    }
  }, [commandQuery, setState]);

  const commandPaletteTitle = t("commandpalette.Title", {
    defaultValue: "Command palette",
  });
  const commandPaletteDescription = t("commandpalette.Description", {
    defaultValue: "Search commands and jump straight to actions.",
  });
  const commandSearchLabel = t("commandpalette.SearchLabel", {
    defaultValue: "Search commands",
  });
  const commandResultsLabel = t("commandpalette.ResultsLabel", {
    defaultValue: "Command results",
  });
  const activeCommand =
    filteredCommands.length > 0 ? filteredCommands[commandActiveIndex] : null;
  const activeOptionId = activeCommand
    ? `command-palette-option-${activeCommand.id}`
    : undefined;

  const handlePaletteKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeCommandPalette();
        return;
      }

      if (e.key === "ArrowDown") {
        if (filteredCommands.length === 0) return;
        e.preventDefault();
        setState(
          "commandActiveIndex",
          commandActiveIndex < filteredCommands.length - 1
            ? commandActiveIndex + 1
            : 0,
        );
        return;
      }

      if (e.key === "ArrowUp") {
        if (filteredCommands.length === 0) return;
        e.preventDefault();
        setState(
          "commandActiveIndex",
          commandActiveIndex > 0
            ? commandActiveIndex - 1
            : filteredCommands.length - 1,
        );
        return;
      }

      if (e.key === "Enter") {
        if (filteredCommands.length === 0) return;
        e.preventDefault();
        const cmd = filteredCommands[commandActiveIndex];
        if (cmd) {
          cmd.action();
          closeCommandPalette();
        }
      }
    },
    [closeCommandPalette, commandActiveIndex, filteredCommands, setState],
  );

  return (
    <Dialog
      open={commandPaletteOpen}
      onOpenChange={(v: boolean) => {
        if (!v) closeCommandPalette();
      }}
    >
      <DialogContent
        className="flex max-h-[min(420px,calc(100dvh_-_1rem))] w-[min(calc(100vw_-_1rem),32.5rem)] max-w-none flex-col rounded-xl p-0 sm:top-[30%] sm:translate-y-0"
        onKeyDown={handlePaletteKeyDown}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{commandPaletteTitle}</DialogTitle>
          <DialogDescription>{commandPaletteDescription}</DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          id="command-palette-search"
          type="text"
          className="w-full px-4 py-3.5 bg-transparent text-sm outline-none font-body"
          style={{
            borderBottom: "1px solid var(--border)",
            color: "var(--text)",
          }}
          placeholder={t("commandpalette.TypeToSearchComma")}
          aria-label={commandSearchLabel}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={commandPaletteOpen}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          value={commandQuery}
          onChange={(e) => setState("commandQuery", e.target.value)}
        />
        <div
          id={listboxId}
          role="listbox"
          aria-label={commandResultsLabel}
          className="flex-1 overflow-y-auto py-1"
        >
          {filteredCommands.length === 0 ? (
            <div
              role="status"
              aria-live="polite"
              className="py-5 text-center text-sm"
              style={{ color: "var(--muted)" }}
            >
              {t("commandpalette.NoCommandsFound")}
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => (
              <Button
                variant="ghost"
                key={cmd.id}
                id={`command-palette-option-${cmd.id}`}
                role="option"
                aria-selected={idx === commandActiveIndex}
                className="flex h-auto w-full cursor-pointer items-center justify-between gap-3 rounded-none border-0 px-4 py-2.5 text-left font-body text-sm"
                style={{
                  background:
                    idx === commandActiveIndex
                      ? "var(--bg-hover)"
                      : "transparent",
                  color: "var(--text)",
                }}
                onClick={() => {
                  cmd.action();
                  closeCommandPalette();
                }}
                onMouseEnter={() => setState("commandActiveIndex", idx)}
              >
                <span className="min-w-0 truncate">{cmd.label}</span>
                {cmd.hint && (
                  <span
                    className="shrink-0 text-xs"
                    style={{ color: "var(--muted)" }}
                  >
                    {cmd.hint}
                  </span>
                )}
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
