/**
 * Plugins / Skills / Store / Catalog state — extracted from AppContext.
 *
 * Manages plugin list and config, skill list and create/delete/review/marketplace
 * flows, the store (registry plugins), and the catalog (marketplace skills).
 *
 * Accepts `{ setActionNotice }` for cross-domain notifications.
 */

import { useCallback, useState } from "react";
import {
  type CatalogSkill,
  client,
  type PluginInfo,
  type RegistryPlugin,
  type SkillInfo,
  type SkillMarketplaceResult,
  type SkillScanReportSummary,
} from "../api";
import { normalizeOnboardingProviderId } from "../providers";
import { confirmDesktopAction } from "../utils";

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Priority-ordered patterns for picking the *primary* sensitive credential
 * field on a plugin. Order matters: when multiple sensitive params exist
 * (e.g. a GitHub App with both `GITHUB_API_TOKEN` and
 * `GITHUB_APP_PRIVATE_KEY`) we want the most-typical request credential
 * picked, not a webhook secret or signing key.
 */
const SENSITIVE_FIELD_PRIORITY: ReadonlyArray<RegExp> = [
  /api[_-]?key$/i,
  /api[_-]?token$/i,
  /[_-]token$/i,
  /auth[_-]?token$/i,
  /bot[_-]?token$/i,
  /access[_-]?token$/i,
  /secret[_-]?key$/i,
  /private[_-]?key$/i,
  /client[_-]?secret$/i,
];

/**
 * Pick the primary sensitive credential parameter from a plugin's
 * declared parameter list. Walks the priority list in order and returns
 * the first sensitive param whose key matches. Falls back to the first
 * sensitive parameter if none match (explicit contract: documented and
 * tested).
 */
export function pickPrimaryCredentialParam<
  P extends { key: string; sensitive: boolean },
>(params: readonly P[]): P | undefined {
  const sensitive = params.filter((p) => p.sensitive);
  for (const pattern of SENSITIVE_FIELD_PRIORITY) {
    const found = sensitive.find((p) => pattern.test(p.key));
    if (found) return found;
  }
  return sensitive[0];
}

interface PluginsSkillsStateParams {
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;
  setPendingRestart: (value: boolean | ((prev: boolean) => boolean)) => void;
  setPendingRestartReasons: (
    value: string[] | ((prev: string[]) => string[]),
  ) => void;
  showRestartBanner: () => void;
  triggerRestart: () => Promise<void>;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function usePluginsSkillsState({
  setActionNotice,
  setPendingRestart,
  setPendingRestartReasons,
  showRestartBanner,
  triggerRestart,
}: PluginsSkillsStateParams) {
  // --- Plugins ---
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginsLoaded, setPluginsLoaded] = useState(false);
  const [pluginFilter, setPluginFilter] = useState<
    "all" | "ai-provider" | "connector" | "feature" | "streaming"
  >("all");
  const [pluginStatusFilter, setPluginStatusFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [pluginSearch, setPluginSearch] = useState("");
  const [pluginSettingsOpen, setPluginSettingsOpen] = useState<Set<string>>(
    new Set(),
  );
  const [pluginAdvancedOpen, setPluginAdvancedOpen] = useState<Set<string>>(
    new Set(),
  );
  const [pluginSaving, setPluginSaving] = useState<Set<string>>(new Set());
  const [pluginSaveSuccess, setPluginSaveSuccess] = useState<Set<string>>(
    new Set(),
  );

  // --- Skills ---
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsSubTab, setSkillsSubTab] = useState<"my" | "browse">("my");
  const [skillCreateFormOpen, setSkillCreateFormOpen] = useState(false);
  const [skillCreateName, setSkillCreateName] = useState("");
  const [skillCreateDescription, setSkillCreateDescription] = useState("");
  const [skillCreating, setSkillCreating] = useState(false);
  const [skillReviewReport, setSkillReviewReport] =
    useState<SkillScanReportSummary | null>(null);
  const [skillReviewId, setSkillReviewId] = useState("");
  const [skillReviewLoading, setSkillReviewLoading] = useState(false);
  const [skillToggleAction, setSkillToggleAction] = useState("");
  const [skillsMarketplaceQuery, setSkillsMarketplaceQuery] = useState("");
  const [skillsMarketplaceResults, setSkillsMarketplaceResults] = useState<
    SkillMarketplaceResult[]
  >([]);
  const [skillsMarketplaceError, setSkillsMarketplaceError] = useState("");
  const [skillsMarketplaceLoading, setSkillsMarketplaceLoading] =
    useState(false);
  const [skillsMarketplaceAction, setSkillsMarketplaceAction] = useState("");
  const [
    skillsMarketplaceManualGithubUrl,
    setSkillsMarketplaceManualGithubUrl,
  ] = useState("");

  // --- Store ---
  const [storePlugins, setStorePlugins] = useState<RegistryPlugin[]>([]);
  const [storeSearch, setStoreSearch] = useState("");
  const [storeFilter, setStoreFilter] = useState<
    "all" | "installed" | "ai-provider" | "connector" | "feature"
  >("all");
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeInstalling, setStoreInstalling] = useState<Set<string>>(
    new Set(),
  );
  const [storeUninstalling, setStoreUninstalling] = useState<Set<string>>(
    new Set(),
  );
  const [storeError, setStoreError] = useState<string | null>(null);
  const [storeDetailPlugin, setStoreDetailPlugin] =
    useState<RegistryPlugin | null>(null);
  const [storeSubTab, setStoreSubTab] = useState<"plugins" | "skills">(
    "plugins",
  );

  // --- Catalog ---
  const [catalogSkills, setCatalogSkills] = useState<CatalogSkill[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogTotalPages, setCatalogTotalPages] = useState(1);
  const [catalogSort, setCatalogSort] = useState<
    "downloads" | "stars" | "updated" | "name"
  >("downloads");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogDetailSkill, setCatalogDetailSkill] =
    useState<CatalogSkill | null>(null);
  const [catalogInstalling, setCatalogInstalling] = useState<Set<string>>(
    new Set(),
  );
  const [catalogUninstalling, setCatalogUninstalling] = useState<Set<string>>(
    new Set(),
  );

  // ── Plugin callbacks ────────────────────────────────────────────────

  const loadPlugins = useCallback(async (_options?: { silent?: boolean }) => {
    try {
      const { plugins: p } = await client.getPlugins();
      setPlugins(p);
      setPluginsLoaded(true);
    } catch {
      /* ignore */
    }
  }, []);

  const ensurePluginsLoaded = useCallback(
    async (options?: { refresh?: boolean }) => {
      if (pluginsLoaded && !options?.refresh) return;
      await loadPlugins(pluginsLoaded ? { silent: true } : undefined);
    },
    [loadPlugins, pluginsLoaded],
  );

  const handlePluginToggle = useCallback(
    async (pluginId: string, enabled: boolean) => {
      const plugin = plugins.find((p: PluginInfo) => p.id === pluginId);
      const pluginName = plugin?.name ?? pluginId;
      if (
        enabled &&
        plugin?.validationErrors &&
        plugin.validationErrors.length > 0
      ) {
        setPluginSettingsOpen((prev) => new Set([...prev, pluginId]));
        setActionNotice(
          `${pluginName} has required settings. Configure them after enabling.`,
          "info",
          3400,
        );
      }
      try {
        setActionNotice(
          `${enabled ? "Enabling" : "Disabling"} ${pluginName}...`,
          "info",
          4200,
        );
        const result = await client.updatePlugin(pluginId, { enabled });
        const hasBlockingValidationErrors =
          enabled &&
          Boolean(
            plugin?.validationErrors && plugin.validationErrors.length > 0,
          );
        if (result.requiresRestart) {
          const restartReason = `Plugin toggle: ${pluginId}`;
          setPendingRestart(true);
          setPendingRestartReasons((prev) =>
            prev.includes(restartReason) ? prev : [...prev, restartReason],
          );
          showRestartBanner();
        }
        if (result.requiresRestart && !hasBlockingValidationErrors) {
          await triggerRestart();
        }
        await loadPlugins();
        setActionNotice(
          result.requiresRestart
            ? hasBlockingValidationErrors
              ? `${pluginName} ${enabled ? "enabled" : "disabled"}. Restart required to apply.`
              : `${pluginName} ${enabled ? "enabled" : "disabled"}.`
            : `${pluginName} ${enabled ? "enabled" : "disabled"} without a full agent restart.`,
          "success",
          2800,
        );
      } catch (err) {
        await loadPlugins().catch(() => {
          /* ignore */
        });
        setActionNotice(
          `Failed to ${enabled ? "enable" : "disable"} ${pluginName}: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
          "error",
          4200,
        );
      }
    },
    [
      plugins,
      loadPlugins,
      setActionNotice,
      setPendingRestart,
      setPendingRestartReasons,
      showRestartBanner,
      triggerRestart,
    ],
  );

  const handlePluginConfigSave = useCallback(
    async (pluginId: string, config: Record<string, string>) => {
      if (Object.keys(config).length === 0) return;
      setPluginSaving((prev) => new Set([...prev, pluginId]));
      try {
        const result = await client.updatePlugin(pluginId, { config });
        const vaultMirrorFailures = result.vaultMirrorFailures ?? [];

        // Check if this is an AI provider plugin
        const plugin = plugins.find((p) => p.id === pluginId);
        const isAiProvider = plugin?.category === "ai-provider";
        let providerSwitchError: Error | null = null;

        // When saving an AI provider's API key, also trigger a provider
        // switch so the runtime restarts with the new plugin loaded.
        if (isAiProvider) {
          const providerId =
            normalizeOnboardingProviderId(pluginId) ?? pluginId;
          // Identify the primary credential field by its STRUCTURE, not
          // by iterating values. The plugin's parameter metadata
          // declares which fields are sensitive; the picker walks a
          // priority-ordered list of common credential name patterns
          // (API_KEY, *_TOKEN, *_PRIVATE_KEY, etc.) and falls back to
          // the first sensitive param. This closes the bug where typing
          // a model field before the API-key field allowed the model
          // slug to be picked up by `Object.values(config).find()` and
          // overwrite the actual key, and handles connectors whose
          // primary credential is a token/private key, not an API key.
          const apiKeyParam = plugin
            ? pickPrimaryCredentialParam(plugin.parameters)
            : undefined;
          const providerApiKey = apiKeyParam
            ? config[apiKeyParam.key]
            : undefined;
          try {
            await client.switchProvider(providerId, providerApiKey);
          } catch (err) {
            providerSwitchError =
              err instanceof Error ? err : new Error(String(err));
          }
        }

        if (result.requiresRestart && !isAiProvider) {
          const restartReason = `Plugin config updated: ${pluginId}`;
          setPendingRestart(true);
          setPendingRestartReasons((prev) =>
            prev.includes(restartReason) ? prev : [...prev, restartReason],
          );
          showRestartBanner();
          await triggerRestart();
        }

        await loadPlugins();
        const notice =
          vaultMirrorFailures.length > 0
            ? `Plugin settings saved, but vault storage failed for ${vaultMirrorFailures.join(", ")}.`
            : isAiProvider
              ? providerSwitchError
                ? `Provider settings saved, but activating ${plugin?.name ?? pluginId} failed: ${providerSwitchError.message}`
                : "Provider settings saved. Restarting agent..."
              : result.requiresRestart
                ? "Plugin settings saved. Agent restarted."
                : "Plugin settings saved without a full agent restart.";
        const noticeTone =
          (isAiProvider && providerSwitchError) ||
          vaultMirrorFailures.length > 0
            ? "error"
            : "success";
        setActionNotice(notice, noticeTone);
        setPluginSaveSuccess((prev) => new Set([...prev, pluginId]));
        setTimeout(() => {
          setPluginSaveSuccess((prev) => {
            const next = new Set(prev);
            next.delete(pluginId);
            return next;
          });
        }, 2000);
      } catch (err) {
        setActionNotice(
          `Save failed: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          3800,
        );
      } finally {
        setPluginSaving((prev) => {
          const next = new Set(prev);
          next.delete(pluginId);
          return next;
        });
      }
    },
    [
      loadPlugins,
      plugins,
      setActionNotice,
      setPendingRestart,
      setPendingRestartReasons,
      showRestartBanner,
      triggerRestart,
    ],
  );

  // ── Skill callbacks ─────────────────────────────────────────────────

  const loadSkills = useCallback(async () => {
    try {
      const { skills: s } = await client.getSkills();
      setSkills(s);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshSkills = useCallback(async () => {
    try {
      const { skills: s } = await client.refreshSkills();
      setSkills(s);
    } catch {
      try {
        const { skills: s } = await client.getSkills();
        setSkills(s);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const handleSkillToggle = useCallback(
    async (skillId: string, enabled: boolean) => {
      setSkillToggleAction(skillId);
      try {
        const { skill } = enabled
          ? await client.enableSkill(skillId)
          : await client.disableSkill(skillId);
        setSkills((prev) =>
          prev.map((s) =>
            s.id === skillId ? { ...s, enabled: skill.enabled } : s,
          ),
        );
        setActionNotice(
          `${skill.name} ${skill.enabled ? "enabled" : "disabled"}.`,
          "success",
        );
      } catch (err) {
        setActionNotice(
          `Failed to update skill: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          4200,
        );
      } finally {
        setSkillToggleAction("");
      }
    },
    [setActionNotice],
  );

  const handleCreateSkill = useCallback(async () => {
    const name = skillCreateName.trim();
    if (!name) return;
    setSkillCreating(true);
    try {
      const result = await client.createSkill(
        name,
        skillCreateDescription.trim() || "",
      );
      setSkillCreateName("");
      setSkillCreateDescription("");
      setSkillCreateFormOpen(false);
      setActionNotice(`Skill "${name}" created.`, "success");
      await refreshSkills();
      if (result.path)
        await client.openSkill(result.skill?.id ?? name).catch(() => undefined);
    } catch (err) {
      setActionNotice(
        `Failed to create skill: ${err instanceof Error ? err.message : "error"}`,
        "error",
        4200,
      );
    } finally {
      setSkillCreating(false);
    }
  }, [skillCreateName, skillCreateDescription, refreshSkills, setActionNotice]);

  const handleOpenSkill = useCallback(
    async (skillId: string) => {
      try {
        await client.openSkill(skillId);
        setActionNotice("Opening skill folder...", "success", 2000);
      } catch (err) {
        setActionNotice(
          `Failed to open: ${err instanceof Error ? err.message : "error"}`,
          "error",
          4200,
        );
      }
    },
    [setActionNotice],
  );

  const handleDeleteSkill = useCallback(
    async (skillId: string, skillName: string) => {
      const confirmed = await confirmDesktopAction({
        title: "Delete Skill",
        message: `Delete skill "${skillName}"?`,
        detail: "This cannot be undone.",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        type: "warning",
      });
      if (!confirmed) return;
      try {
        await client.deleteSkill(skillId);
        setActionNotice(`Skill "${skillName}" deleted.`, "success");
        await refreshSkills();
      } catch (err) {
        setActionNotice(
          `Failed to delete: ${err instanceof Error ? err.message : "error"}`,
          "error",
          4200,
        );
      }
    },
    [refreshSkills, setActionNotice],
  );

  const handleReviewSkill = useCallback(async (skillId: string) => {
    setSkillReviewId(skillId);
    setSkillReviewLoading(true);
    setSkillReviewReport(null);
    try {
      const { report } = await client.getSkillScanReport(skillId);
      setSkillReviewReport(report);
    } catch {
      setSkillReviewReport(null);
    } finally {
      setSkillReviewLoading(false);
    }
  }, []);

  const handleAcknowledgeSkill = useCallback(
    async (skillId: string) => {
      try {
        await client.acknowledgeSkill(skillId, true);
        setActionNotice(
          `Skill "${skillId}" acknowledged and enabled.`,
          "success",
        );
        setSkillReviewReport(null);
        setSkillReviewId("");
        await refreshSkills();
      } catch (err) {
        setActionNotice(
          `Failed: ${err instanceof Error ? err.message : "error"}`,
          "error",
          4200,
        );
      }
    },
    [refreshSkills, setActionNotice],
  );

  const searchSkillsMarketplace = useCallback(async () => {
    const query = skillsMarketplaceQuery.trim();
    if (!query) {
      setSkillsMarketplaceResults([]);
      setSkillsMarketplaceError("");
      return;
    }
    setSkillsMarketplaceLoading(true);
    setSkillsMarketplaceError("");
    try {
      const { results } = await client.searchSkillsMarketplace(
        query,
        false,
        20,
      );
      setSkillsMarketplaceResults(results);
    } catch (err) {
      setSkillsMarketplaceResults([]);
      setSkillsMarketplaceError(
        err instanceof Error ? err.message : "unknown error",
      );
    } finally {
      setSkillsMarketplaceLoading(false);
    }
  }, [skillsMarketplaceQuery]);

  const installSkillFromMarketplace = useCallback(
    async (item: SkillMarketplaceResult) => {
      setSkillsMarketplaceAction(`install:${item.id}`);
      try {
        await client.installMarketplaceSkill({
          slug: item.slug ?? item.id,
          githubUrl: item.githubUrl,
          repository: item.repository,
          path: item.path ?? undefined,
          name: item.name,
          description: item.description,
          source: item.source ?? "clawhub",
          autoRefresh: true,
        });
        await refreshSkills();
        setActionNotice(`Installed skill: ${item.name}`, "success");
      } catch (err) {
        setActionNotice(
          `Skill install failed: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          4200,
        );
      } finally {
        setSkillsMarketplaceAction("");
      }
    },
    [refreshSkills, setActionNotice],
  );

  const installSkillFromGithubUrl = useCallback(async () => {
    const githubUrl = skillsMarketplaceManualGithubUrl.trim();
    if (!githubUrl) return;
    setSkillsMarketplaceAction("install:manual");
    try {
      let repository: string | undefined;
      let skillPath: string | undefined;
      let inferredName: string | undefined;
      try {
        const parsed = new URL(githubUrl);
        if (parsed.hostname === "github.com") {
          const parts = parsed.pathname.split("/").filter(Boolean);
          if (parts.length >= 2) repository = `${parts[0]}/${parts[1]}`;
          if (parts[2] === "tree" && parts.length >= 5) {
            skillPath = parts.slice(4).join("/");
            inferredName = parts[parts.length - 1];
          }
        }
      } catch {
        /* keep raw URL */
      }
      await client.installMarketplaceSkill({
        githubUrl,
        repository,
        path: skillPath,
        name: inferredName,
        source: "manual",
        autoRefresh: true,
      });
      setSkillsMarketplaceManualGithubUrl("");
      await refreshSkills();
      setActionNotice("Skill installed from GitHub URL.", "success");
    } catch (err) {
      setActionNotice(
        `GitHub install failed: ${err instanceof Error ? err.message : "unknown error"}`,
        "error",
        4200,
      );
    } finally {
      setSkillsMarketplaceAction("");
    }
  }, [skillsMarketplaceManualGithubUrl, refreshSkills, setActionNotice]);

  const uninstallMarketplaceSkill = useCallback(
    async (skillId: string, name: string) => {
      setSkillsMarketplaceAction(`uninstall:${skillId}`);
      try {
        await client.deleteSkill(skillId);
        await refreshSkills();
        setActionNotice(`Uninstalled skill: ${name}`, "success");
      } catch (err) {
        setActionNotice(
          `Skill uninstall failed: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          4200,
        );
      } finally {
        setSkillsMarketplaceAction("");
      }
    },
    [refreshSkills, setActionNotice],
  );

  const enableMarketplaceSkill = useCallback(
    async (skillId: string, name: string) => {
      setSkillsMarketplaceAction(`enable:${skillId}`);
      try {
        await client.enableSkill(skillId);
        await refreshSkills();
        setActionNotice(`${name} enabled.`, "success");
      } catch (err) {
        setActionNotice(
          `Failed to enable ${name}: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          4200,
        );
      } finally {
        setSkillsMarketplaceAction("");
      }
    },
    [refreshSkills, setActionNotice],
  );

  const disableMarketplaceSkill = useCallback(
    async (skillId: string, name: string) => {
      setSkillsMarketplaceAction(`disable:${skillId}`);
      try {
        await client.disableSkill(skillId);
        await refreshSkills();
        setActionNotice(`${name} disabled.`, "success");
      } catch (err) {
        setActionNotice(
          `Failed to disable ${name}: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          4200,
        );
      } finally {
        setSkillsMarketplaceAction("");
      }
    },
    [refreshSkills, setActionNotice],
  );

  const copyMarketplaceSkillSource = useCallback(
    async (skillId: string, name: string) => {
      setSkillsMarketplaceAction(`copy:${skillId}`);
      try {
        const { content } = await client.getSkillSource(skillId);
        if (typeof navigator === "undefined" || !navigator.clipboard) {
          throw new Error("Clipboard API unavailable in this environment");
        }
        await navigator.clipboard.writeText(content);
        setActionNotice(`Copied ${name} SKILL.md to clipboard.`, "success");
      } catch (err) {
        setActionNotice(
          `Failed to copy ${name}: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          4200,
        );
      } finally {
        setSkillsMarketplaceAction("");
      }
    },
    [setActionNotice],
  );

  // ── Return ──────────────────────────────────────────────────────────

  return {
    // Plugin state
    plugins,
    setPlugins,
    pluginFilter,
    setPluginFilter,
    pluginStatusFilter,
    setPluginStatusFilter,
    pluginSearch,
    setPluginSearch,
    pluginSettingsOpen,
    setPluginSettingsOpen,
    pluginAdvancedOpen,
    setPluginAdvancedOpen,
    pluginSaving,
    setPluginSaving,
    pluginSaveSuccess,
    setPluginSaveSuccess,

    // Plugin callbacks
    loadPlugins,
    ensurePluginsLoaded,
    handlePluginToggle,
    handlePluginConfigSave,

    // Skill state
    skills,
    setSkills,
    skillsSubTab,
    setSkillsSubTab,
    skillCreateFormOpen,
    setSkillCreateFormOpen,
    skillCreateName,
    setSkillCreateName,
    skillCreateDescription,
    setSkillCreateDescription,
    skillCreating,
    setSkillCreating,
    skillReviewReport,
    setSkillReviewReport,
    skillReviewId,
    setSkillReviewId,
    skillReviewLoading,
    setSkillReviewLoading,
    skillToggleAction,
    setSkillToggleAction,
    skillsMarketplaceQuery,
    setSkillsMarketplaceQuery,
    skillsMarketplaceResults,
    setSkillsMarketplaceResults,
    skillsMarketplaceError,
    setSkillsMarketplaceError,
    skillsMarketplaceLoading,
    setSkillsMarketplaceLoading,
    skillsMarketplaceAction,
    setSkillsMarketplaceAction,
    skillsMarketplaceManualGithubUrl,
    setSkillsMarketplaceManualGithubUrl,

    // Skill callbacks
    loadSkills,
    refreshSkills,
    handleSkillToggle,
    handleCreateSkill,
    handleOpenSkill,
    handleDeleteSkill,
    handleReviewSkill,
    handleAcknowledgeSkill,
    searchSkillsMarketplace,
    installSkillFromMarketplace,
    installSkillFromGithubUrl,
    uninstallMarketplaceSkill,
    enableMarketplaceSkill,
    disableMarketplaceSkill,
    copyMarketplaceSkillSource,

    // Store state
    storePlugins,
    setStorePlugins,
    storeSearch,
    setStoreSearch,
    storeFilter,
    setStoreFilter,
    storeLoading,
    setStoreLoading,
    storeInstalling,
    setStoreInstalling,
    storeUninstalling,
    setStoreUninstalling,
    storeError,
    setStoreError,
    storeDetailPlugin,
    setStoreDetailPlugin,
    storeSubTab,
    setStoreSubTab,

    // Catalog state
    catalogSkills,
    setCatalogSkills,
    catalogTotal,
    setCatalogTotal,
    catalogPage,
    setCatalogPage,
    catalogTotalPages,
    setCatalogTotalPages,
    catalogSort,
    setCatalogSort,
    catalogSearch,
    setCatalogSearch,
    catalogLoading,
    setCatalogLoading,
    catalogError,
    setCatalogError,
    catalogDetailSkill,
    setCatalogDetailSkill,
    catalogInstalling,
    setCatalogInstalling,
    catalogUninstalling,
    setCatalogUninstalling,
  };
}
