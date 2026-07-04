/**
 * Loads the universal slash-command catalog for the chat composer and exposes
 * the app-level side effects the menu needs (navigation, clear, palette). The
 * overlay combines these with its own conversation-scoped effects (send,
 * new-conversation, fullscreen) to run a command.
 */

import { logger } from "@elizaos/logger";
import type { CustomActionDef } from "@elizaos/shared";
import * as React from "react";
import { client } from "../api";
import type {
  CommandArgSource,
  SlashCommandCatalogItem,
} from "../api/client-types-commands";
import {
  resolveSettingsSectionToken,
  SETTINGS_SECTION_SUGGESTIONS,
} from "../components/settings/settings-section-tokens";
import { useBootConfig } from "../config/boot-config-react.hooks";
import { COMMAND_PALETTE_EVENT, dispatchNavigateViewEvent } from "../events";
import { useAvailableViews } from "../hooks/useAvailableViews";
import type { Tab } from "../navigation";
import { useAppSelectorShallow } from "../state";
import { getElizaApiBase, getElizaApiToken } from "../utils/eliza-globals";
import { loadSavedCustomCommands, normalizeSlashCommandName } from "./index";
import { filterCommandsForSurface } from "./slash-menu";

/** The surface the dashboard chat composer renders on. */
const GUI_SURFACE = "gui" as const;

/** Event the App shell listens for to open settings at a specific section. */
export const NAVIGATE_SETTINGS_EVENT = "eliza:navigate:settings";

/**
 * Report a user-initiated view switch to the agent (#8792). Fire-and-forget,
 * fully guarded: a failure here must never break navigation. `source: "user"`
 * makes the server record state + emit VIEW_SWITCHED without echoing
 * shell:navigate:view back to the client. The surface id is any view/tab id
 * (e.g. a view id, a tab id, or "settings") the proactive decider keys off.
 */
export function reportUserViewSwitch(viewId: string, viewPath?: string): void {
  try {
    const base = getElizaApiBase();
    if (!base || typeof fetch === "undefined") return;
    const token = getElizaApiToken();
    void fetch(`${base}/api/views/${encodeURIComponent(viewId)}/navigate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        source: "user",
        ...(viewPath ? { path: viewPath } : {}),
      }),
    }).catch((err) => {
      // error-policy:J7 telemetry write must not break navigation; warn keeps
      // a dead reporting endpoint observable in the console.
      logger.warn(
        `[useSlashCommandController] view-switch report failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } catch {
    // error-policy:J7 same guard for synchronous setup failures — telemetry
    // must never break navigation.
  }
}

/**
 * Report a user-fired keyboard / command-palette shortcut to the agent (#8792).
 * Fire-and-forget, fully guarded: a failure here must never break the shortcut.
 * The server emits SHORTCUT_FIRED for the proactive decider, which decides
 * (governed) whether a scoped comment helps. Only meaningful, intent-bearing
 * shortcuts should report — not every keystroke — to keep the judge cheap.
 */
export function reportShortcutFired(
  shortcutId: string,
  context?: string,
): void {
  try {
    const base = getElizaApiBase();
    if (!base || typeof fetch === "undefined") return;
    const token = getElizaApiToken();
    void fetch(`${base}/api/interactions/shortcut`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        shortcutId,
        ...(context ? { context } : {}),
      }),
    }).catch((err) => {
      // error-policy:J7 telemetry write must not break the shortcut; warn keeps
      // a dead reporting endpoint observable in the console.
      logger.warn(
        `[useSlashCommandController] shortcut report failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } catch {
    // error-policy:J7 same guard for synchronous setup failures — telemetry
    // must never break the shortcut.
  }
}

export interface NavigateSettingsDetail {
  section?: string;
}

export interface SlashCommandController {
  /** The merged catalog (server commands + custom actions + saved commands). */
  commands: SlashCommandCatalogItem[];
  loading: boolean;
  /**
   * True when the last catalog load failed at the transport/parse layer (the
   * server command fetch OR the custom-actions fetch threw). Lets the surface
   * render a distinguishable error state instead of a healthy-empty menu
   * (#12784 three-state degrade): a network/5xx/parse failure must not
   * masquerade as a genuinely empty catalog. Locally-derived commands
   * (saved/custom) still render when only one source failed, so `commands`
   * may be non-empty while `error` is true (partial/degraded load).
   */
  error: boolean;
  /** Whether natural-language navigate/client shortcuts may short-circuit send. */
  naturalShortcutsEnabled: boolean;
  /** Resolve dynamic argument completions for a named source. */
  resolveChoices: (source: CommandArgSource) => string[];
  /** Map a user-typed settings token to a canonical section id. */
  resolveSection: (token: string) => string | undefined;
  /**
   * Whether the current sender is authorized (rank ≥ USER). Exposed so the
   * natural-language shortcut path re-applies the SAME gate as the visible menu
   * (#12087 Item 20) instead of defaulting fail-open.
   */
  isAuthorized: boolean;
  /** Whether the current sender is elevated (OWNER). See {@link isAuthorized}. */
  isElevated: boolean;
  // ── App-level side effects ────────────────────────────────────────────────
  navigateTab: (tab: string) => void;
  navigateSettings: (section?: string) => void;
  navigateView: (target: { viewId?: string; viewPath?: string }) => void;
  clearChat: () => void;
  openCommandPalette: () => void;
}

function customActionToCommand(name: string): SlashCommandCatalogItem {
  const slug = name.toLowerCase();
  return {
    key: `custom-action:${slug}`,
    nativeName: slug,
    description: "Custom action",
    textAliases: [`/${slug}`],
    scope: "text",
    acceptsArgs: true,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "agent" },
    source: "custom-action",
    icon: "zap",
  };
}

function savedCommandToCommand(name: string): SlashCommandCatalogItem {
  const slug = normalizeSlashCommandName(name);
  return {
    key: `saved:${slug}`,
    nativeName: slug,
    description: "Saved command",
    textAliases: [`/${slug}`],
    scope: "text",
    acceptsArgs: true,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "agent" },
    source: "saved",
    icon: "bookmark",
  };
}

/** Merge catalogs, keeping the first definition for any duplicated alias. */
function mergeByAlias(
  groups: SlashCommandCatalogItem[][],
): SlashCommandCatalogItem[] {
  const seen = new Set<string>();
  const merged: SlashCommandCatalogItem[] = [];
  for (const group of groups) {
    for (const command of group) {
      const aliasKeys = command.textAliases.map((a) => a.toLowerCase());
      if (aliasKeys.some((a) => seen.has(a))) continue;
      for (const a of aliasKeys) seen.add(a);
      merged.push(command);
    }
  }
  return merged;
}

export interface SlashCommandControllerOptions {
  /**
   * Whether the current sender is authorized (rank ≥ USER). Commands flagged
   * `requiresAuth` are hidden when this is false. Defaults to `false`
   * (fail-closed, #12087 Item 20): the caller MUST derive this from the
   * authoritative role (`useRole().atLeast("USER")`). A missing option must not
   * silently expose gated commands to an anonymous/remote sender.
   */
  isAuthorized?: boolean;
  /**
   * Whether the current sender has elevated/owner privileges. Commands flagged
   * `requiresElevated` are hidden when this is false. Defaults to `false`
   * (fail-closed) for the same reason as {@link isAuthorized}; derive from
   * `useRole().isOwner`.
   */
  isElevated?: boolean;
}

export function useSlashCommandController(
  options: SlashCommandControllerOptions = {},
): SlashCommandController {
  const { isAuthorized = false, isElevated = false } = options;
  const bootConfig = useBootConfig();
  const { setTab, handleChatClear } = useAppSelectorShallow((s) => ({
    setTab: s.setTab,
    handleChatClear: s.handleChatClear,
  }));
  const { views } = useAvailableViews();
  const [serverCommands, setServerCommands] = React.useState<
    SlashCommandCatalogItem[]
  >([]);
  const [customCommands, setCustomCommands] = React.useState<
    SlashCommandCatalogItem[]
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    void (async () => {
      // Degrade to an empty catalog so the composer keeps working, but SURFACE
      // the failure: a silently-swallowed fetch error is indistinguishable
      // from a genuinely empty catalog (the menu just never mounts), which
      // made #11112 needlessly hard to diagnose. Beyond the console log we also
      // raise a user-facing `error` flag (#12784 three-state) so the menu can
      // show a distinguishable degraded state, not a false healthy-empty.
      let loadFailed = false;
      const catalog: SlashCommandCatalogItem[] = await client
        .listCommands("gui")
        // error-policy:J4 degrade to an empty catalog with the failure logged
        // + flagged (not fabricated as a healthy-empty catalog).
        .catch((error: unknown) => {
          loadFailed = true;
          console.error(
            "[useSlashCommandController] Failed to load the slash-command catalog; slash menu will be empty",
            error,
          );
          return [];
        });
      const customActions: CustomActionDef[] = await client
        .listCustomActions()
        // error-policy:J4 omit custom actions with the failure logged + flagged.
        .catch((error: unknown) => {
          loadFailed = true;
          console.error(
            "[useSlashCommandController] Failed to load custom actions; omitting them from the slash menu",
            error,
          );
          return [];
        });
      if (cancelled) return;
      setServerCommands(catalog);
      const saved = loadSavedCustomCommands().map((c) =>
        savedCommandToCommand(c.name),
      );
      const custom = customActions
        .filter((a) => a.enabled)
        .map((a) => customActionToCommand(a.name));
      setCustomCommands([...saved, ...custom]);
      setLoadError(loadFailed);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const commands = React.useMemo(
    // Server catalog wins over custom/saved on alias collisions; then gate by
    // surface (hide non-gui commands) and sender authorization (hide
    // requiresAuth/requiresElevated commands the sender can't run).
    () =>
      filterCommandsForSurface(mergeByAlias([serverCommands, customCommands]), {
        surface: GUI_SURFACE,
        isAuthorized,
        isElevated,
      }),
    [serverCommands, customCommands, isAuthorized, isElevated],
  );
  const naturalShortcutsEnabled =
    bootConfig.shortcutFlags?.naturalLanguage === true;

  const resolveChoices = React.useCallback(
    (source: CommandArgSource): string[] => {
      switch (source) {
        case "settings-sections":
          return SETTINGS_SECTION_SUGGESTIONS;
        case "views":
          return views.map((v) => v.id);
        default:
          return [];
      }
    },
    [views],
  );

  const navigateTab = React.useCallback(
    (tab: string) => {
      setTab(tab as Tab);
      // Report the tab id as a surface so the proactive decider can react to
      // user-initiated tab navigation (#8792). Fire-and-forget.
      reportUserViewSwitch(tab);
    },
    [setTab],
  );

  const navigateSettings = React.useCallback((section?: string) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent<NavigateSettingsDetail>(NAVIGATE_SETTINGS_EVENT, {
        detail: { section },
      }),
    );
    // Surface key is "settings" with the section threaded through as the path
    // so the decider can distinguish settings sub-screens (#8792).
    reportUserViewSwitch("settings", section);
  }, []);

  const navigateView = React.useCallback(
    (target: { viewId?: string; viewPath?: string }) => {
      if (typeof window === "undefined") return;
      dispatchNavigateViewEvent({
        viewId: target.viewId,
        viewPath: target.viewPath,
      });
      // Report this user-initiated switch to the agent (#8792) so the server's
      // current-view state stays accurate and a VIEW_SWITCHED event fires for the
      // proactive decider. `source: "user"` tells the server to record + emit
      // WITHOUT re-broadcasting shell:navigate:view (the client already
      // navigated above), avoiding an echo loop. Fire-and-forget.
      if (target.viewId) {
        reportUserViewSwitch(target.viewId, target.viewPath);
      }
    },
    [],
  );

  const clearChat = React.useCallback(() => {
    void handleChatClear();
  }, [handleChatClear]);

  const openCommandPalette = React.useCallback(() => {
    if (typeof document === "undefined") return;
    document.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
  }, []);

  return React.useMemo(
    () => ({
      commands,
      loading,
      error: loadError,
      naturalShortcutsEnabled,
      resolveChoices,
      resolveSection: resolveSettingsSectionToken,
      isAuthorized,
      isElevated,
      navigateTab,
      navigateSettings,
      navigateView,
      clearChat,
      openCommandPalette,
    }),
    [
      commands,
      loading,
      loadError,
      naturalShortcutsEnabled,
      resolveChoices,
      isAuthorized,
      isElevated,
      navigateTab,
      navigateSettings,
      navigateView,
      clearChat,
      openCommandPalette,
    ],
  );
}
