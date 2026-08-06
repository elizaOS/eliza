"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Command } from "@/lib/shortcuts";

const RECENT_MAX = 5;
const RECENT_KEY = "claude-code-recent-commands";

interface CommandRegistryContextValue {
  /** Live list of all registered commands for UI rendering */
  commands: Command[];
  /** Ref always pointing to the latest commands list — use in event handlers */
  commandsRef: React.MutableRefObject<Command[]>;
  registerCommand: (cmd: Command) => () => void;
  /** Run a command by id and record it as recently used */
  runCommand: (id: string) => void;

  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;

  helpOpen: boolean;
  openHelp: () => void;
  closeHelp: () => void;

  recentCommandIds: string[];
}

const CommandRegistryContext = createContext<CommandRegistryContextValue>({
  commands: [],
  commandsRef: { current: [] },
  registerCommand: () => () => {},
  runCommand: () => {},
  paletteOpen: false,
  openPalette: () => {},
  closePalette: () => {},
  helpOpen: false,
  openHelp: () => {},
  closeHelp: () => {},
  recentCommandIds: [],
});

export function CommandRegistryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [commands, setCommands] = useState<Command[]>([]);
  const commandsRef = useRef<Command[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    } catch {
      return [];
    }
  });

  const registerCommand = useCallback((cmd: Command) => {
    setCommands((prev) => {
      const next = [...prev.filter((c) => c.id !== cmd.id), cmd];
      commandsRef.current = next;
      return next;
    });
    return () => {
      setCommands((prev) => {
        const next = prev.filter((c) => c.id !== cmd.id);
        commandsRef.current = next;
        return next;
      });
    };
  }, []);

  const addToRecent = useCallback((id: string) => {
    setRecentCommandIds((prev) => {
      const next = [id, ...prev.filter((r) => r !== id)].slice(0, RECENT_MAX);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const runCommand = useCallback(
    (id: string) => {
      const cmd = commandsRef.current.find((c) => c.id === id);
      if (!cmd) return;
      if (cmd.when && !cmd.when()) return;
      addToRecent(id);
      cmd.action();
    },
    [addToRecent]
  );

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  // Keep commandsRef in sync when state updates
  useEffect(() => {
    commandsRef.current = commands;
  }, [commands]);

  return (
    <CommandRegistryContext.Provider
      value={{
        commands,
        commandsRef,
        registerCommand,
        runCommand,
        paletteOpen,
        openPalette,
        closePalette,
        helpOpen,
        openHelp,
        closeHelp,
        recentCommandIds,
      }}
    >
      {children}
    </CommandRegistryContext.Provider>
  );
}

export function useCommandRegistry() {
  return useContext(CommandRegistryContext);
}
