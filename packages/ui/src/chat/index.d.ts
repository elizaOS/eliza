/**
 * Chat command utilities — slash command parsing, saved command management,
 * and the typed command registry.
 */
import type { Tab } from "../navigation";
import type { DesktopClickAuditItem, DesktopWorkspaceSurface } from "../utils/desktop-workspace";
export declare const CUSTOM_COMMANDS_STORAGE_KEY = "eliza:custom-commands";
export interface SavedCustomCommand {
    name: string;
    text: string;
    createdAt: number;
}
export declare function loadSavedCustomCommands(): SavedCustomCommand[];
export declare function saveSavedCustomCommands(commands: SavedCustomCommand[]): void;
export declare function appendSavedCustomCommand(command: SavedCustomCommand): void;
export declare function normalizeSlashCommandName(value: string): string;
export declare function expandSavedCustomCommand(template: string, argsRaw: string): string;
export declare function splitCommandArgs(raw: string): string[];
export declare function isRoutineCodingAgentMessage(message: {
    source?: string;
    text: string;
}): boolean;
export * from "./coding-agent-session-state";
export type CommandCategory = "agent" | "navigation" | "refresh" | "utility" | "desktop";
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
export declare const NAV_COMMANDS: readonly {
    id: string;
    label: string;
    tab: Tab;
}[];
export interface BuildCommandsArgs {
    agentState: string;
    activeGameViewerUrl: string;
    handleStart: () => void;
    handleStop: () => void;
    handleRestart: () => void;
    setTab: (tab: Tab) => void;
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
    openDesktopSurfaceWindow: (surface: DesktopWorkspaceSurface, options?: {
        browse?: string;
    }) => void;
}
export declare const DESKTOP_COMMAND_CLICK_AUDIT: readonly DesktopClickAuditItem[];
export declare function buildCommands(args: BuildCommandsArgs): CommandItem[];
//# sourceMappingURL=index.d.ts.map