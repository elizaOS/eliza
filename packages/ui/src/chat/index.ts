/**
 * Chat command utilities — slash command parsing, saved command management,
 * and the typed command registry.
 */

import {
  type EnabledViewKinds,
  isViewVisible,
  MESSAGE_SOURCE_CODING_AGENT,
} from "@elizaos/core";
import type { ViewRegistryEntry } from "../hooks/useAvailableViews";
import type { Tab } from "../navigation";
import type {
  DesktopClickAuditItem,
  DesktopWorkspaceSurface,
} from "../utils/desktop-workspace";
import { DESKTOP_WORKSPACE_SURFACES } from "../utils/desktop-workspace";

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
    message.source === MESSAGE_SOURCE_CODING_AGENT &&
    ROUTINE_CODING_AGENT_RE.test(message.text)
  );
}

export * from "./coding-agent-session-state";

// ── Typed command registry ───────────────────────────────────────────────

export type CommandCategory =
  | "agent"
  | "navigation"
  | "refresh"
  | "utility"
  | "desktop";

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

// Static navigation commands for the built-in top-level tabs — always present.
// Plugin-provided views are added dynamically by the palette from the live view
// registry (see `views`/`navigateView` below), so this list only covers the
// fixed shell surfaces. All palette navigation reports VIEW_SWITCHED (#8792).
export const NAV_COMMANDS: readonly { id: string; label: string; tab: Tab }[] =
  [
    { id: "nav-chat", label: "Open Chat", tab: "chat" },
    // Views + Apps consolidated into the single Launcher (#9143).
    { id: "nav-launcher", label: "Open Launcher", tab: "views" },
    { id: "nav-character", label: "Open Character", tab: "character" },
    { id: "nav-triggers", label: "Open Triggers", tab: "triggers" },
    { id: "nav-inventory", label: "Open Wallet", tab: "inventory" },
    { id: "nav-documents", label: "Open Knowledge", tab: "documents" },
    { id: "nav-tasks", label: "Open Tasks", tab: "tasks" },
    { id: "nav-automations", label: "Open Automations", tab: "automations" },
    { id: "nav-messages", label: "Open Messages", tab: "messages" },
    { id: "nav-contacts", label: "Open Contacts", tab: "contacts" },
    { id: "nav-phone", label: "Open Phone", tab: "phone" },
    {
      id: "nav-relationships",
      label: "Open Relationships",
      tab: "relationships",
    },
    { id: "nav-browser", label: "Open Browser", tab: "browser" },
    { id: "nav-skills", label: "Open Skills", tab: "skills" },
    { id: "nav-transcripts", label: "Open Transcripts", tab: "transcripts" },
    { id: "nav-memories", label: "Open Memories", tab: "memories" },
    { id: "nav-files", label: "Open Files", tab: "files" },
    { id: "nav-plugins", label: "Open Plugins", tab: "plugins" },
    { id: "nav-settings", label: "Open Settings", tab: "settings" },
    { id: "nav-database", label: "Open Database", tab: "database" },
    { id: "nav-logs", label: "Open Logs", tab: "logs" },
  ] as const;

/** A registered plugin/shell view the palette can navigate to (from /api/views). */
export interface ViewNavEntry {
  id: string;
  label: string;
  path?: string;
}

/**
 * Filter the live view registry to the user-visible GUI views the command
 * palette should offer (#8792). Mirrors the view catalog's visibility gate
 * (`isVisibleCatalogView`) so the palette never surfaces developer/preview or
 * internal (`visibleInManager: false`) views the rest of the shell hides.
 */
export function paletteViewEntries(
  views: readonly ViewRegistryEntry[],
  enabledKinds: EnabledViewKinds,
): ViewNavEntry[] {
  return views
    .filter(
      (v) =>
        v.available !== false &&
        (v.viewType ?? "gui") === "gui" &&
        v.visibleInManager !== false &&
        isViewVisible(v, enabledKinds),
    )
    .map((v) => ({ id: v.id, label: v.label, path: v.path }));
}

export interface BuildCommandsArgs {
  agentState: string;
  activeGameViewerUrl: string;
  handleStart: () => void;
  handleStop: () => void;
  handleRestart: () => void;
  /** Navigate to a built-in tab AND report it to the agent (VIEW_SWITCHED). */
  navigateTab: (tab: Tab) => void;
  /** Navigate to a registered plugin/shell view AND report it (VIEW_SWITCHED). */
  navigateView: (viewId: string, path?: string) => void;
  /** Live registered views (user-facing) to expose as palette nav entries. */
  views: readonly ViewNavEntry[];
  setAppsSubTab: () => void;
  loadPlugins: () => void;
  loadSkills: () => void;
  loadLogs: () => void;
  loadWorkbench: () => void;
  handleChatClear: () => void;
  openBugReport: () => void;
  desktopRuntime: boolean;
  focusDesktopMainWindow: () => void;
  openDesktopSettingsWindow: (tabHint?: string) => void;
  openDesktopSurfaceWindow: (
    surface: DesktopWorkspaceSurface,
    options?: { browse?: string },
  ) => void;
}

export const DESKTOP_COMMAND_CLICK_AUDIT: readonly DesktopClickAuditItem[] = [
  {
    id: "desktop-open-workspace",
    entryPoint: "command-palette",
    label: "Open Desktop Workspace",
    expectedAction:
      "Open a detached settings window focused on the desktop workspace section.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "desktop-open-voice-controls",
    entryPoint: "command-palette",
    label: "Open Voice Controls",
    expectedAction:
      "Open a detached settings window focused on the voice section.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "desktop-focus-main-window",
    entryPoint: "command-palette",
    label: "Focus Main Window",
    expectedAction: "Focus the main desktop window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  ...DESKTOP_WORKSPACE_SURFACES.map(
    (surface): DesktopClickAuditItem => ({
      id: `desktop-command-${surface.id}`,
      entryPoint: "command-palette",
      label: `Open ${surface.label}`,
      expectedAction: `Open the detached ${surface.id} surface from the command palette.`,
      runtimeRequirement: "desktop",
      coverage: "automated",
    }),
  ),
] as const;

export function buildCommands(args: BuildCommandsArgs): CommandItem[] {
  const {
    agentState,
    activeGameViewerUrl,
    handleStart,
    handleStop,
    handleRestart,
    navigateTab,
    navigateView,
    views,
    setAppsSubTab,
    loadPlugins,
    loadSkills,
    loadLogs,
    loadWorkbench,
    handleChatClear,
    openBugReport,
    desktopRuntime,
    focusDesktopMainWindow,
    openDesktopSettingsWindow,
    openDesktopSurfaceWindow,
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
  } else {
    commands.push({
      id: "stop-agent",
      label: "Stop Agent",
      category: "agent",
      action: handleStop,
    });
  }
  commands.push({
    id: "restart-agent",
    label: "Restart Agent",
    category: "agent",
    shortcut: "Ctrl+R",
    action: handleRestart,
  });

  // Navigation — built-in tabs.
  const navLabels = new Set<string>();
  for (const nav of NAV_COMMANDS) {
    navLabels.add(nav.label.toLowerCase());
    commands.push({
      id: nav.id,
      label: nav.label,
      category: "navigation",
      action: () => navigateTab(nav.tab),
    });
  }

  // Navigation — every registered plugin/shell view, so the palette is a
  // complete launcher (#8792). Deduped by label against the built-in tabs above
  // (e.g. don't list "Open Wallet" twice when a wallet view is also registered).
  for (const view of views) {
    const label = `Open ${view.label}`;
    const key = label.toLowerCase();
    if (navLabels.has(key)) continue;
    navLabels.add(key);
    commands.push({
      id: `view-${view.id}`,
      label,
      category: "navigation",
      action: () => navigateView(view.id, view.path),
    });
  }

  if (activeGameViewerUrl.trim()) {
    commands.push({
      id: "nav-current-game",
      label: "Open Current Game",
      category: "navigation",
      action: () => {
        navigateTab("apps");
        setAppsSubTab();
      },
    });
  }

  if (desktopRuntime) {
    commands.push(
      {
        id: "desktop-open-workspace",
        label: "Open Desktop Workspace",
        category: "desktop",
        action: () => openDesktopSettingsWindow("desktop"),
      },
      {
        id: "desktop-open-voice-controls",
        label: "Open Voice Controls",
        category: "desktop",
        action: () => openDesktopSettingsWindow("voice"),
      },
      {
        id: "desktop-focus-main-window",
        label: "Focus Main Window",
        category: "desktop",
        action: focusDesktopMainWindow,
      },
      ...DESKTOP_WORKSPACE_SURFACES.map((surface) => ({
        id: `desktop-command-${surface.id}`,
        label: `Open ${surface.label}`,
        category: "desktop" as const,
        hint: surface.description,
        action: () => openDesktopSurfaceWindow(surface.id),
      })),
    );
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
