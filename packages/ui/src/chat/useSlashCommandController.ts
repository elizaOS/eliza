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
  isApiError,
  type ModelCatalogProviders,
} from "../api/client-types-core";
import {
  resolveSettingsSectionToken,
  SETTINGS_SECTION_SUGGESTIONS,
} from "../components/settings/settings-section-tokens";
import { useBootConfig } from "../config/boot-config-react.hooks";
import { COMMAND_PALETTE_EVENT, dispatchNavigateViewEvent } from "../events";
import { useAvailableViews } from "../hooks/useAvailableViews";
import { useProtectedAgentProbesEnabled } from "../hooks/useProtectedAgentProbesEnabled";
import type { Tab } from "../navigation";
import { useAppSelectorShallow } from "../state";
import { getElizaApiBase, getElizaApiToken } from "../utils/eliza-globals";
import { loadSavedCustomCommands, normalizeSlashCommandName } from "./index";
import { buildModelChoiceLabels, resolveModelChoices } from "./model-choices";
import {
  filterCommandsForSurface,
  type SlashArgChoiceContext,
} from "./slash-menu";

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
  /**
   * Resolve dynamic argument completions for a named source. `context` carries
   * the completion position so positional sources (the "models" grammar) can
   * return per-subcommand values; sources without positional needs ignore it.
   */
  resolveChoices: (
    source: CommandArgSource,
    context?: SlashArgChoiceContext,
  ) => string[];
  /** Display label for a resolved choice ("" when the value speaks for itself). */
  describeChoice: (source: CommandArgSource, choice: string) => string;
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

function isExpectedCatalogAuthError(error: unknown): boolean {
  return isApiError(error) && (error.status === 401 || error.status === 403);
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
  const [modelCatalog, setModelCatalog] =
    React.useState<ModelCatalogProviders | null>(null);
  // The catalog load hits the protected GET /api/commands + /api/custom-actions;
  // hold it until probes are allowed so fresh Cloud onboarding fires no 401
  // (#16242). Re-runs to populate the menu once the gate opens post-sign-in.
  const probesEnabled = useProtectedAgentProbesEnabled();

  React.useEffect(() => {
    if (!probesEnabled) {
      // No session yet on the shared Cloud app — present a resolved-empty
      // catalog (not a perpetual spinner) and skip the protected fetches.
      setServerCommands([]);
      setCustomCommands([]);
      setLoadError(false);
      setLoading(false);
      return;
    }
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
          // A 401/403 means the viewer isn't authenticated (or the agent
          // session lapsed) — the catalog is legitimately unavailable, not a
          // diagnosable failure. Degrade quietly rather than console.error-
          // storming the logged-out agent app (#14663). Real failures still
          // surface via loadFailed + the log below.
          if (isExpectedCatalogAuthError(error)) {
            return [];
          }
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
          // See above: an unauthenticated 401/403 is expected, not a failure —
          // degrade quietly instead of logging (#14663).
          if (isExpectedCatalogAuthError(error)) {
            return [];
          }
          loadFailed = true;
          console.error(
            "[useSlashCommandController] Failed to load custom actions; omitting them from the slash menu",
            error,
          );
          return [];
        });
      if (cancelled) return;
      // The model catalog only matters when a command actually declares a
      // "models" dynamic arg (a cold GET /api/models can fan out provider
      // fetches server-side), and it must not delay the command menu — fetched
      // in parallel, resolved into state whenever it lands.
      if (
        catalog.some((command) =>
          command.args.some((arg) => arg.dynamicChoices === "models"),
        )
      ) {
        void client
          .getModelsCatalog()
          .then((models) => {
            if (!cancelled) setModelCatalog(models.catalog.providers);
          })
          .catch((error: unknown) => {
            // error-policy:J4 model completions degrade to none with the
            // failure logged; an unauthenticated 401/403 is expected (#14663).
            if (isExpectedCatalogAuthError(error)) return;
            console.error(
              "[useSlashCommandController] Failed to load the model catalog; model completions will be empty",
              error,
            );
          });
      }
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
  }, [probesEnabled]);

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
    (source: CommandArgSource, context?: SlashArgChoiceContext): string[] => {
      switch (source) {
        case "settings-sections":
          return SETTINGS_SECTION_SUGGESTIONS;
        case "views":
          return views.map((v) => v.id);
        case "models":
          return resolveModelChoices(modelCatalog, context);
        default:
          return [];
      }
    },
    [views, modelCatalog],
  );

  const modelChoiceLabels = React.useMemo(
    () => buildModelChoiceLabels(modelCatalog),
    [modelCatalog],
  );
  const describeChoice = React.useCallback(
    (source: CommandArgSource, choice: string): string =>
      source === "models" ? (modelChoiceLabels.get(choice) ?? "") : "",
    [modelChoiceLabels],
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
      describeChoice,
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
      describeChoice,
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
