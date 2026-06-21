/**
 * Loads the universal slash-command catalog for the chat composer and exposes
 * the app-level side effects the menu needs (navigation, clear, palette). The
 * overlay combines these with its own conversation-scoped effects (send,
 * new-conversation, fullscreen) to run a command.
 */

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
import { COMMAND_PALETTE_EVENT } from "../events";
import { useAvailableViews } from "../hooks/useAvailableViews";
import type { Tab } from "../navigation";
import { useApp } from "../state";
import { getElizaApiBase, getElizaApiToken } from "../utils/eliza-globals";
import { loadSavedCustomCommands, normalizeSlashCommandName } from "./index";

/** Event the App shell listens for to open settings at a specific section. */
export const NAVIGATE_SETTINGS_EVENT = "eliza:navigate:settings";

/**
 * Report a user-initiated view switch to the agent (#8792). Fire-and-forget,
 * fully guarded: a failure here must never break navigation. `source: "user"`
 * makes the server record state + emit VIEW_SWITCHED without echoing
 * shell:navigate:view back to the client.
 */
function reportUserViewSwitch(viewId: string, viewPath?: string): void {
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
    }).catch(() => {});
  } catch {
    // Best-effort observability only.
  }
}

export interface NavigateSettingsDetail {
  section?: string;
}

export interface SlashCommandController {
  /** The merged catalog (server commands + custom actions + saved commands). */
  commands: SlashCommandCatalogItem[];
  loading: boolean;
  /** Resolve dynamic argument completions for a named source. */
  resolveChoices: (source: CommandArgSource) => string[];
  /** Map a user-typed settings token to a canonical section id. */
  resolveSection: (token: string) => string | undefined;
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

export function useSlashCommandController(): SlashCommandController {
  const { setTab, handleChatClear } = useApp();
  const { views } = useAvailableViews();
  const [serverCommands, setServerCommands] = React.useState<
    SlashCommandCatalogItem[]
  >([]);
  const [customCommands, setCustomCommands] = React.useState<
    SlashCommandCatalogItem[]
  >([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const catalog: SlashCommandCatalogItem[] = await client
        .listCommands("gui")
        .catch(() => []);
      const customActions: CustomActionDef[] = await client
        .listCustomActions()
        .catch(() => []);
      if (cancelled) return;
      setServerCommands(catalog);
      const saved = loadSavedCustomCommands().map((c) =>
        savedCommandToCommand(c.name),
      );
      const custom = customActions
        .filter((a) => a.enabled)
        .map((a) => customActionToCommand(a.name));
      setCustomCommands([...saved, ...custom]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const commands = React.useMemo(
    // Server catalog wins over custom/saved on alias collisions.
    () => mergeByAlias([serverCommands, customCommands]),
    [serverCommands, customCommands],
  );

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
    (tab: string) => setTab(tab as Tab),
    [setTab],
  );

  const navigateSettings = React.useCallback((section?: string) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent<NavigateSettingsDetail>(NAVIGATE_SETTINGS_EVENT, {
        detail: { section },
      }),
    );
  }, []);

  const navigateView = React.useCallback(
    (target: { viewId?: string; viewPath?: string }) => {
      if (typeof window === "undefined") return;
      window.dispatchEvent(
        new CustomEvent("eliza:navigate:view", {
          detail: {
            viewId: target.viewId,
            viewPath: target.viewPath,
          },
        }),
      );
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
      resolveChoices,
      resolveSection: resolveSettingsSectionToken,
      navigateTab,
      navigateSettings,
      navigateView,
      clearChat,
      openCommandPalette,
    }),
    [
      commands,
      loading,
      resolveChoices,
      navigateTab,
      navigateSettings,
      navigateView,
      clearChat,
      openCommandPalette,
    ],
  );
}
