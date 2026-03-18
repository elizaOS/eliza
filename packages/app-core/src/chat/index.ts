/**
 * Chat command utilities — slash command parsing, saved command management,
 * and the typed command registry.
 *
 * Migrated from apps/app/src/chat-commands.ts and command-registry.ts.
 */

import type { Tab } from "../navigation";

const ROUTINE_CODING_AGENT_RE =
  /^\[.+?\] (?:Approved:|Responded:|Sent keys:|Turn done, continuing:|Idle for \d+[smh])/;

// ── Saved custom commands ────────────────────────────────────────────────

export const CUSTOM_COMMANDS_STORAGE_KEY = "eliza:custom-commands";

export interface SavedCustomCommand {
  name: string;
  text: string;
  createdAt: number;
}

function isSavedCustomCommand(value: unknown): value is SavedCustomCommand {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.createdAt === "number"
  );
}

export function loadSavedCustomCommands(): SavedCustomCommand[] {
  try {
    const raw = localStorage.getItem(CUSTOM_COMMANDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedCustomCommand);
  } catch {
    return [];
  }
}

export function saveSavedCustomCommands(commands: SavedCustomCommand[]): void {
  localStorage.setItem(CUSTOM_COMMANDS_STORAGE_KEY, JSON.stringify(commands));
}

export function appendSavedCustomCommand(command: SavedCustomCommand): void {
  const existing = loadSavedCustomCommands();
  existing.push(command);
  saveSavedCustomCommands(existing);
}

export function normalizeSlashCommandName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return withoutSlash.trim().toLowerCase();
}

export function expandSavedCustomCommand(
  template: string,
  argsRaw: string,
): string {
  const args = argsRaw.trim();
  if (!args) {
    return template;
  }
  if (template.includes("{{args}}")) {
    return template.replaceAll("{{args}}", args);
  }
  return `${template}\n${args}`;
}

export function splitCommandArgs(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null = re.exec(raw);
  while (match) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    match = re.exec(raw);
  }
  return tokens;
}

export function isRoutineCodingAgentMessage(message: {
  source?: string;
  text: string;
}): boolean {
  return (
    message.source === "coding-agent" &&
    ROUTINE_CODING_AGENT_RE.test(message.text)
  );
}

// ── Typed command registry ───────────────────────────────────────────────

export type CommandCategory = "agent" | "navigation" | "refresh" | "utility";

export interface CommandDef {
  id: string;
  label: string;
  category: CommandCategory;
  /** Keyboard shortcut hint shown in palette / tooltips. */
  shortcut?: string;
  /** Extra hint text (e.g., current state). */
  hint?: string;
}

export interface CommandItem extends CommandDef {
  action: () => void;
}

// Static navigation commands — always present; palette builder binds setTab.
export const NAV_COMMANDS: readonly { id: string; label: string; tab: Tab }[] =
  [
    { id: "nav-chat", label: "Open Chat", tab: "chat" },
    { id: "nav-apps", label: "Open Apps", tab: "apps" },
    { id: "nav-character", label: "Open Character", tab: "character" },
    { id: "nav-triggers", label: "Open Heartbeats", tab: "triggers" },
    { id: "nav-wallets", label: "Open Wallets", tab: "wallets" },
    { id: "nav-knowledge", label: "Open Knowledge", tab: "knowledge" },
    { id: "nav-connectors", label: "Open Connectors", tab: "connectors" },
    { id: "nav-plugins", label: "Open Plugins", tab: "plugins" },
    { id: "nav-settings", label: "Open Settings", tab: "settings" },
    { id: "nav-database", label: "Open Database", tab: "database" },
    { id: "nav-logs", label: "Open Logs", tab: "logs" },
    { id: "nav-security", label: "Open Security", tab: "security" },
  ] as const;

export interface BuildCommandsArgs {
  agentState: string;
  activeGameViewerUrl: string;
  handleStart: () => void;

  handleRestart: () => void;
  setTab: (tab: Tab) => void;
  setAppsSubTab: () => void;
  loadPlugins: () => void;
  loadSkills: () => void;
  loadLogs: () => void;
  loadWorkbench: () => void;
  handleChatClear: () => void;
  openBugReport: () => void;
}

export function buildCommands(args: BuildCommandsArgs): CommandItem[] {
  const {
    agentState,
    activeGameViewerUrl,
    handleStart,

    handleRestart,
    setTab,
    setAppsSubTab,
    loadPlugins,
    loadSkills,
    loadLogs,
    loadWorkbench,
    handleChatClear,
    openBugReport,
  } = args;

  const commands: CommandItem[] = [];
  // Agent control
  if (agentState === "stopped" || agentState === "not_started") {
    commands.push({
      id: "start-agent",
      label: "Start Agent",
      category: "agent",
      action: handleStart,
    });
  }
  commands.push({
    id: "restart-agent",
    label: "Restart Agent",
    category: "agent",
    shortcut: "Ctrl+R",
    action: handleRestart,
  });

  // Navigation
  for (const nav of NAV_COMMANDS) {
    commands.push({
      id: nav.id,
      label: nav.label,
      category: "navigation",
      action: () => setTab(nav.tab),
    });
  }

  if (activeGameViewerUrl.trim()) {
    commands.push({
      id: "nav-current-game",
      label: "Open Current Game",
      category: "navigation",
      action: () => {
        setTab("apps");
        setAppsSubTab();
      },
    });
  }

  // Refresh
  commands.push(
    {
      id: "refresh-plugins",
      label: "Refresh Features",
      category: "refresh",
      action: loadPlugins,
    },
    {
      id: "refresh-skills",
      label: "Refresh Skills",
      category: "refresh",
      action: loadSkills,
    },
    {
      id: "refresh-logs",
      label: "Refresh Logs",
      category: "refresh",
      action: loadLogs,
    },
    {
      id: "refresh-workbench",
      label: "Refresh Workbench",
      category: "refresh",
      action: loadWorkbench,
    },
  );

  // Utility
  commands.push(
    {
      id: "chat-clear",
      label: "Clear Chat",
      category: "utility",
      action: handleChatClear,
    },
    {
      id: "report-bug",
      label: "Report Bug",
      category: "utility",
      action: openBugReport,
    },
  );

  return commands;
}
