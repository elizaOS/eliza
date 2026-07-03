import { Package, Puzzle } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import type { PluginInfo } from "../../api";
import { client } from "../../api";
import { useLinkedSidebarSelection } from "../../hooks/useLinkedSidebarSelection";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { PageLayoutHeader } from "../../layouts/page-layout/page-layout-header";
import { useAppSelectorShallow } from "../../state";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import { openExternalUrl } from "../../utils";
import { ChatSearchHint } from "../composites/chat-search-hint";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { PluginCard } from "./PluginCard";
import {
  buildPluginListState,
  getPluginResourceLinks,
  iconImageSource,
  type PluginsViewMode,
  resolveIcon,
  type StatusFilter,
  SUBGROUP_DISPLAY_ORDER,
  SUBGROUP_LABELS,
  SUBGROUP_NAV_ICONS,
  subgroupForPlugin,
} from "./plugin-list-utils";
import {
  ConnectorPluginGroups,
  type PluginConnectionTestResult,
} from "./plugin-view-connectors";
import { PluginSettingsDialog } from "./plugin-view-dialogs";
import { PluginGameModal } from "./plugin-view-modal";

/* ── Shared PluginListView ─────────────────────────────────────────── */

interface PluginListViewProps {
  /** Label used in search placeholder and empty state messages. */
  label: string;
  /** Optional shared content header rendered above the content pane. */
  contentHeader?: ReactNode;
  /** Optional list mode for pre-filtered views like Connectors. */
  mode?: PluginsViewMode;
  /** Whether the view is rendered in a full-screen gamified modal. */
  inModal?: boolean;
  /** Desktop-only placement for the connector list sidebar. */
  connectorDesktopPlacement?: "left" | "right";
}

function PluginListView({
  label,
  contentHeader,
  mode = "all",
  inModal,
}: PluginListViewProps) {
  const {
    plugins = [],
    pluginStatusFilter = "all",
    pluginSearch = "",
    pluginSettingsOpen = new Set<string>(),
    pluginSaving,
    pluginSaveSuccess,
    isLoadingPlugins = false,
    pluginsLoadError = null,
    pluginsLoaded = false,
    loadPlugins,
    ensurePluginsLoaded = async () => {
      await loadPlugins();
    },
    handlePluginToggle,
    handlePluginConfigSave,
    setActionNotice,
    setState,
    t,
  } = useAppSelectorShallow((s) => ({
    plugins: s.plugins,
    pluginStatusFilter: s.pluginStatusFilter,
    pluginSearch: s.pluginSearch,
    pluginSettingsOpen: s.pluginSettingsOpen,
    pluginSaving: s.pluginSaving,
    pluginSaveSuccess: s.pluginSaveSuccess,
    isLoadingPlugins: s.isLoadingPlugins,
    pluginsLoadError: s.pluginsLoadError,
    pluginsLoaded: s.pluginsLoaded,
    loadPlugins: s.loadPlugins,
    ensurePluginsLoaded: s.ensurePluginsLoaded,
    handlePluginToggle: s.handlePluginToggle,
    handlePluginConfigSave: s.handlePluginConfigSave,
    setActionNotice: s.setActionNotice,
    setState: s.setState,
    t: s.t,
  }));

  // The floating chat composer is this view's search box. While Plugins is the
  // active view it takes over the composer (placeholder + live draft) and feeds
  // each keystroke into the shared `pluginSearch` filter — there's no in-page
  // search input.
  const searchPlaceholder = t("pluginsview.SearchPlaceholder", {
    defaultValue: "Search plugins…",
  });
  const handleSearchQuery = useCallback(
    (value: string) => setState("pluginSearch", value),
    [setState],
  );
  const chatBinding = useMemo(
    () => ({ placeholder: searchPlaceholder, onQuery: handleSearchQuery }),
    [searchPlaceholder, handleSearchQuery],
  );
  useRegisterViewChatBinding(chatBinding);

  const [pluginConfigs, setPluginConfigs] = useState<
    Record<string, Record<string, string>>
  >({});
  const [testResults, setTestResults] = useState<
    Map<string, PluginConnectionTestResult>
  >(new Map());
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(
    new Set(),
  );
  const [installProgress, setInstallProgress] = useState<
    Map<string, { phase: string; message: string }>
  >(new Map());
  const [updatingPlugins, setUpdatingPlugins] = useState<Set<string>>(
    new Set(),
  );
  const [uninstallingPlugins, setUninstallingPlugins] = useState<Set<string>>(
    new Set(),
  );
  const [pluginReleaseStreams, setPluginReleaseStreams] = useState<
    Record<string, "latest" | "beta">
  >({});
  const pluginDescriptionFallback = t("pluginsview.NoDescriptionAvailable", {
    defaultValue: "No description available",
  });
  const installProgressLabel = (message?: string) =>
    message ||
    t("common.installing", {
      defaultValue: "Installing...",
    });
  const installPluginLabel = t("pluginsview.InstallPlugin", {
    defaultValue: "Install Plugin",
  });
  const installLabel = t("common.install", {
    defaultValue: "Install",
  });
  const testingLabel = t("common.testing", {
    defaultValue: "Testing...",
  });
  const saveSettingsLabel = t("pluginsview.SaveSettings", {
    defaultValue: "Save Settings",
  });
  const saveLabel = t("common.save", { defaultValue: "Save" });
  const savingLabel = t("common.saving", {
    defaultValue: "Saving...",
  });
  const savedLabel = t("common.saved", {
    defaultValue: "Saved",
  });
  const savedWithBangLabel = t("pluginsview.SavedWithBang", {
    defaultValue: "Saved!",
  });
  const readyLabel = t("common.ready", { defaultValue: "Ready" });
  const needsSetupLabel = t("common.needsSetup", {
    defaultValue: "Needs setup",
  });
  const loadFailedLabel = t("pluginsview.LoadFailed", {
    defaultValue: "Load failed",
  });
  const notInstalledLabel = t("pluginsview.NotInstalled", {
    defaultValue: "Not installed",
  });
  const expandLabel = t("common.expand", { defaultValue: "Expand" });
  const collapseLabel = t("common.collapse", {
    defaultValue: "Collapse",
  });
  const noConfigurationNeededLabel = t("pluginsview.NoConfigurationNeeded", {
    defaultValue: "No configuration needed.",
  });
  const connectorInstallPrompt = t("pluginsview.InstallConnectorPrompt", {
    defaultValue: "Install this connector to activate it in the runtime.",
  });
  const formatTestConnectionLabel = (result?: {
    success: boolean;
    error?: string;
    durationMs: number;
    loading: boolean;
  }) => {
    if (result?.loading) return testingLabel;
    if (result?.success) {
      return t("pluginsview.ConnectionTestPassed", {
        durationMs: result.durationMs,
        defaultValue: "OK ({{durationMs}}ms)",
      });
    }
    if (result?.error) {
      return t("pluginsview.ConnectionTestFailed", {
        error: result.error,
        defaultValue: "Failed: {{error}}",
      });
    }
    return t("pluginsview.TestConnection");
  };
  const formatDialogTestConnectionLabel = (result?: {
    success: boolean;
    error?: string;
    durationMs: number;
    loading: boolean;
  }) => {
    if (result?.loading) return testingLabel;
    if (result?.success) {
      return t("pluginsview.ConnectionTestPassedDialog", {
        durationMs: result.durationMs,
        defaultValue: "OK ({{durationMs}}ms)",
      });
    }
    if (result?.error) {
      return t("pluginsview.ConnectionTestFailedDialog", {
        error: result.error,
        defaultValue: "Failed: {{error}}",
      });
    }
    return t("pluginsview.TestConnection");
  };
  const formatSaveSettingsLabel = (isSaving: boolean, didSave: boolean) => {
    if (isSaving) return savingLabel;
    if (didSave) return savedLabel;
    return saveSettingsLabel;
  };
  const [togglingPlugins, setTogglingPlugins] = useState<Set<string>>(
    new Set(),
  );
  const hasPluginToggleInFlight = togglingPlugins.size > 0;
  const [pluginOrder, setPluginOrder] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("pluginOrder");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const isConnectorShellMode = mode === "social";
  const isSocialMode = mode === "social";
  // The connector-accordion shell (inline OAuth / managed-Discord setup) is
  // reserved for the dedicated Connectors surface. The /apps/plugins page
  // ("all-social") renders the visual card grid below.
  const isSidebarEditorShellMode = mode === "social";
  // The card grid honors the live search + status filters from the app bar.
  const isGridSearchMode = mode === "all-social" || mode === "all";
  const isConnectorLikeMode = mode === "connectors" || mode === "social";
  const resultLabel = mode === "social" ? "connectors" : label.toLowerCase();
  const effectiveStatusFilter: StatusFilter = isSidebarEditorShellMode
    ? pluginStatusFilter
    : isGridSearchMode
      ? pluginStatusFilter
      : "all";
  const effectiveSearch =
    isSidebarEditorShellMode || isGridSearchMode ? pluginSearch : "";

  const allowCustomOrder = !isSocialMode;

  // Load plugins on mount — exactly once. `ensurePluginsLoaded` is recreated
  // whenever the underlying `pluginsLoaded` flag flips (its useCallback depends
  // on it), so depending on its identity here re-fires the effect on every such
  // change and, combined with context re-renders, produces a render storm. Read
  // the latest callback through a ref and gate on a one-shot flag instead.
  const ensurePluginsLoadedRef = useRef(ensurePluginsLoaded);
  ensurePluginsLoadedRef.current = ensurePluginsLoaded;
  const didLoadPluginsRef = useRef(false);
  useEffect(() => {
    if (didLoadPluginsRef.current) return;
    didLoadPluginsRef.current = true;
    void ensurePluginsLoadedRef.current();
  }, []);

  // Listen for install progress events via WebSocket
  useEffect(() => {
    const unbind = client.onWsEvent(
      "install-progress",
      (data: Record<string, unknown>) => {
        const pluginName = data.pluginName as string;
        const phase = data.phase as string;
        const message = data.message as string;
        if (!pluginName) return;
        if (phase === "complete" || phase === "error") {
          setInstallProgress((prev) => {
            const next = new Map(prev);
            next.delete(pluginName);
            return next;
          });
        } else {
          setInstallProgress((prev) =>
            new Map(prev).set(pluginName, { phase, message }),
          );
        }
      },
    );
    return unbind;
  }, []);

  // Persist custom order
  useEffect(() => {
    if (pluginOrder.length > 0) {
      localStorage.setItem("pluginOrder", JSON.stringify(pluginOrder));
    }
  }, [pluginOrder]);

  const [subgroupFilter, setSubgroupFilter] = useState<string>("all");
  const showSubgroupFilters =
    mode !== "connectors" && mode !== "streaming" && mode !== "social";
  const { nonDbPlugins, sorted, subgroupTags, visiblePlugins } = useMemo(
    () =>
      buildPluginListState({
        allowCustomOrder,
        effectiveSearch,
        effectiveStatusFilter,
        isConnectorLikeMode,
        mode,
        pluginOrder,
        plugins,
        showSubgroupFilters,
        subgroupFilter,
      }),
    [
      allowCustomOrder,
      effectiveSearch,
      effectiveStatusFilter,
      isConnectorLikeMode,
      mode,
      pluginOrder,
      plugins,
      showSubgroupFilters,
      subgroupFilter,
    ],
  );

  useEffect(() => {
    if (!showSubgroupFilters) return;
    if (subgroupFilter === "all") return;
    if (!subgroupTags.some((tag) => tag.id === subgroupFilter)) {
      setSubgroupFilter("all");
    }
  }, [showSubgroupFilters, subgroupFilter, subgroupTags]);

  const renderSubgroupFilterButton = useCallback(
    (tag: { id: string; label: string; count: number }) => {
      const isActive = subgroupFilter === tag.id;
      const Icon = SUBGROUP_NAV_ICONS[tag.id] ?? Package;

      return (
        <Button
          key={tag.id}
          variant={isActive ? "default" : "outline"}
          size="sm"
          className={`min-h-11 gap-1.5 rounded-full px-3 text-xs-tight font-bold tracking-wide transition-all ${
            isActive
              ? "border-accent bg-accent text-accent-fg hover:bg-accent/90"
              : "border-border/50 bg-card/50 text-muted hover:border-accent/40 hover:text-txt"
          }`}
          onClick={() => setSubgroupFilter(tag.id)}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          {tag.label}
          <span
            className={`ml-0.5 rounded-full px-1.5 py-0.5 text-3xs font-mono leading-none ${
              isActive
                ? "bg-accent-fg/20 text-accent-fg"
                : "bg-bg-accent/80 text-muted-strong"
            }`}
          >
            {tag.count}
          </span>
        </Button>
      );
    },
    [subgroupFilter],
  );

  const toggleSettings = (pluginId: string) => {
    const next = new Set<string>();
    if (!pluginSettingsOpen.has(pluginId)) next.add(pluginId);
    setState("pluginSettingsOpen", next);
  };

  const handleParamChange = (
    pluginId: string,
    paramKey: string,
    value: string,
  ) => {
    setPluginConfigs((prev) => ({
      ...prev,
      [pluginId]: { ...prev[pluginId], [paramKey]: value },
    }));
  };

  const handleConfigSave = async (pluginId: string) => {
    if (pluginId === "__ui-showcase__") return;
    const config = pluginConfigs[pluginId] ?? {};
    // Only clear the draft when the save persisted — sensitive params never
    // echo back from the server, so wiping on failure loses the pasted token.
    const saved = await handlePluginConfigSave(pluginId, config);
    if (!saved) return;
    setPluginConfigs((prev) => {
      const next = { ...prev };
      delete next[pluginId];
      return next;
    });
  };

  const handleConfigReset = (pluginId: string) => {
    setPluginConfigs((prev) => {
      const next = { ...prev };
      delete next[pluginId];
      return next;
    });
  };

  const handleTestConnection = async (pluginId: string) => {
    setTestResults((prev) => {
      const next = new Map(prev);
      next.set(pluginId, { success: false, loading: true, durationMs: 0 });
      return next;
    });
    try {
      const result = await client.testPluginConnection(pluginId);
      setTestResults((prev) => {
        const next = new Map(prev);
        next.set(pluginId, { ...result, loading: false });
        return next;
      });
    } catch (err) {
      setTestResults((prev) => {
        const next = new Map(prev);
        next.set(pluginId, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
          durationMs: 0,
        });
        return next;
      });
    }
  };

  const getSelectedReleaseStream = useCallback(
    (plugin: PluginInfo): "latest" | "beta" =>
      pluginReleaseStreams[plugin.id] ??
      plugin.releaseStream ??
      (plugin.betaVersion ? "beta" : "latest"),
    [pluginReleaseStreams],
  );

  const handleReleaseStreamChange = useCallback(
    (pluginId: string, stream: "latest" | "beta") => {
      setPluginReleaseStreams((prev) => {
        if (prev[pluginId] === stream) return prev;
        return { ...prev, [pluginId]: stream };
      });
    },
    [],
  );

  const clearPluginReleaseStream = useCallback((pluginId: string) => {
    setPluginReleaseStreams((prev) => {
      if (!(pluginId in prev)) return prev;
      const next = { ...prev };
      delete next[pluginId];
      return next;
    });
  }, []);

  // The plugin manager capability ships built-in with @elizaos/core, so no
  // preflight enable / restart is required before invoking lifecycle tasks.
  const runWithPluginManager = useCallback(
    async (
      _pluginName: string,
      _notices: { prepare: string; recover: string },
      task: () => Promise<unknown>,
    ) => task(),
    [],
  );

  const completePluginLifecycleRestart = useCallback(
    async (messages: { waiting: string; success: string; failure: string }) => {
      setActionNotice(messages.waiting, "info", 120_000, false, true);
      const status = await client.restartAndWait(120_000);
      if (status.state !== "running") {
        setActionNotice(
          messages.failure.replace("{{status}}", status.state),
          "error",
          3800,
        );
        return false;
      }
      await loadPlugins();
      setActionNotice(messages.success, "success");
      return true;
    },
    [loadPlugins, setActionNotice],
  );

  const handleInstallPlugin = async (pluginId: string, npmName: string) => {
    const plugin = plugins.find((candidate) => candidate.id === pluginId);
    const stream = plugin ? getSelectedReleaseStream(plugin) : "beta";
    setInstallingPlugins((prev) => new Set(prev).add(pluginId));
    try {
      const result = (await runWithPluginManager(
        npmName,
        {
          prepare: t("pluginsview.PluginInstallPreparing", {
            plugin: npmName,
            defaultValue:
              "Enabling plugin installs for {{plugin}} and restarting the agent...",
          }),
          recover: t("pluginsview.PluginInstallRecovering", {
            plugin: npmName,
            defaultValue:
              "Finishing plugin install setup for {{plugin}} and restarting the agent...",
          }),
        },
        async () =>
          await client.installRegistryPlugin(npmName, false, { stream }),
      )) as Awaited<ReturnType<typeof client.installRegistryPlugin>>;
      if (result.requiresRestart) {
        const restarted = await completePluginLifecycleRestart({
          waiting: t("pluginsview.PluginInstalledRestarting", {
            plugin: npmName,
            defaultValue:
              "{{plugin}} installed. Restarting the agent and waiting for activation...",
          }),
          success: t("pluginsview.PluginInstalledRestartComplete", {
            plugin: npmName,
            defaultValue: "{{plugin}} installed and activated.",
          }),
          failure: t("pluginsview.PluginInstalledRestartFailed", {
            plugin: npmName,
            status: "{{status}}",
            defaultValue:
              "{{plugin}} installed, but the agent did not come back online (status: {{status}}).",
          }),
        });
        // Preserve the chosen stream on install failure so retry uses the same target.
        if (!restarted) return;
      } else {
        await loadPlugins();
        setActionNotice(
          t("pluginsview.PluginInstalledActivated", {
            plugin: npmName,
            defaultValue:
              "{{plugin}} installed and activated without a full agent restart.",
          }),
          "success",
        );
      }
    } catch (err) {
      setActionNotice(
        t("pluginsview.PluginInstallFailed", {
          plugin: npmName,
          message: err instanceof Error ? err.message : "unknown error",
          defaultValue: "Failed to install {{plugin}}: {{message}}",
        }),
        "error",
        3800,
      );
      // The install failure is already surfaced above. This refresh is a
      // best-effort reconciliation in case install partially succeeded; its
      // own failure adds no new actionable information for the user.
      try {
        await loadPlugins();
      } catch {
        /* best-effort refresh; outer error already shown */
      }
    } finally {
      setInstallingPlugins((prev) => {
        const next = new Set(prev);
        next.delete(pluginId);
        return next;
      });
    }
  };

  const handleUpdatePlugin = async (pluginId: string, npmName: string) => {
    const plugin = plugins.find((candidate) => candidate.id === pluginId);
    const stream = plugin ? getSelectedReleaseStream(plugin) : "beta";
    setUpdatingPlugins((prev) => new Set(prev).add(pluginId));
    try {
      const result = (await runWithPluginManager(
        npmName,
        {
          prepare: t("pluginsview.PluginUpdatePreparing", {
            plugin: npmName,
            defaultValue:
              "Preparing updates for {{plugin}} and restarting the agent...",
          }),
          recover: t("pluginsview.PluginUpdateRecovering", {
            plugin: npmName,
            defaultValue:
              "Finishing update setup for {{plugin}} and restarting the agent...",
          }),
        },
        async () =>
          await client.updateRegistryPlugin(npmName, false, { stream }),
      )) as Awaited<ReturnType<typeof client.updateRegistryPlugin>>;
      if (result.requiresRestart) {
        const restarted = await completePluginLifecycleRestart({
          waiting: t("pluginsview.PluginUpdatedRestarting", {
            plugin: npmName,
            defaultValue:
              "{{plugin}} updated. Restarting the agent and waiting for activation...",
          }),
          success: t("pluginsview.PluginUpdatedRestartComplete", {
            plugin: npmName,
            defaultValue: "{{plugin}} updated and activated.",
          }),
          failure: t("pluginsview.PluginUpdatedRestartFailed", {
            plugin: npmName,
            status: "{{status}}",
            defaultValue:
              "{{plugin}} updated, but the agent did not come back online (status: {{status}}).",
          }),
        });
        // Preserve the chosen stream on update failure so retry uses the same target.
        if (!restarted) return;
      } else {
        await loadPlugins();
        setActionNotice(
          t("pluginsview.PluginUpdatedActivated", {
            plugin: npmName,
            defaultValue: "{{plugin}} updated without a full agent restart.",
          }),
          "success",
        );
      }
    } catch (err) {
      setActionNotice(
        t("pluginsview.PluginUpdateFailed", {
          plugin: npmName,
          message: err instanceof Error ? err.message : "unknown error",
          defaultValue: "Failed to update {{plugin}}: {{message}}",
        }),
        "error",
        3800,
      );
      try {
        await loadPlugins();
      } catch {
        /* best-effort refresh; outer error already shown */
      }
    } finally {
      setUpdatingPlugins((prev) => {
        const next = new Set(prev);
        next.delete(pluginId);
        return next;
      });
    }
  };

  const handleUninstallPlugin = async (pluginId: string, npmName: string) => {
    setUninstallingPlugins((prev) => new Set(prev).add(pluginId));
    try {
      const result = (await runWithPluginManager(
        npmName,
        {
          prepare: t("pluginsview.PluginUninstallPreparing", {
            plugin: npmName,
            defaultValue:
              "Preparing uninstall for {{plugin}} and restarting the agent...",
          }),
          recover: t("pluginsview.PluginUninstallRecovering", {
            plugin: npmName,
            defaultValue:
              "Finishing uninstall setup for {{plugin}} and restarting the agent...",
          }),
        },
        async () => await client.uninstallRegistryPlugin(npmName, false),
      )) as Awaited<ReturnType<typeof client.uninstallRegistryPlugin>>;
      if (result.requiresRestart) {
        const restarted = await completePluginLifecycleRestart({
          waiting: t("pluginsview.PluginUninstalledRestarting", {
            plugin: npmName,
            defaultValue:
              "{{plugin}} uninstalled. Restarting the agent and waiting for cleanup...",
          }),
          success: t("pluginsview.PluginUninstalledRestartComplete", {
            plugin: npmName,
            defaultValue: "{{plugin}} uninstalled and fully unloaded.",
          }),
          failure: t("pluginsview.PluginUninstalledRestartFailed", {
            plugin: npmName,
            status: "{{status}}",
            defaultValue:
              "{{plugin}} uninstalled, but the agent did not come back online (status: {{status}}).",
          }),
        });
        if (!restarted) {
          clearPluginReleaseStream(pluginId);
          return;
        }
      } else {
        await loadPlugins();
        setActionNotice(
          t("pluginsview.PluginUninstalledActivated", {
            plugin: npmName,
            defaultValue:
              "{{plugin}} uninstalled without a full agent restart.",
          }),
          "success",
        );
      }
      clearPluginReleaseStream(pluginId);
    } catch (err) {
      setActionNotice(
        t("pluginsview.PluginUninstallFailed", {
          plugin: npmName,
          message: err instanceof Error ? err.message : "unknown error",
          defaultValue: "Failed to uninstall {{plugin}}: {{message}}",
        }),
        "error",
        3800,
      );
      try {
        await loadPlugins();
      } catch {
        /* best-effort refresh; outer error already shown */
      }
    } finally {
      setUninstallingPlugins((prev) => {
        const next = new Set(prev);
        next.delete(pluginId);
        return next;
      });
    }
  };

  const handleTogglePlugin = useCallback(
    async (pluginId: string, enabled: boolean) => {
      let shouldStart = false;
      setTogglingPlugins((prev) => {
        if (prev.has(pluginId) || prev.size > 0) return prev;
        shouldStart = true;
        return new Set(prev).add(pluginId);
      });
      if (!shouldStart) return;

      try {
        await handlePluginToggle(pluginId, enabled);
      } finally {
        setTogglingPlugins((prev) => {
          const next = new Set(prev);
          next.delete(pluginId);
          return next;
        });
      }
    },
    [handlePluginToggle],
  );

  const handleOpenPluginExternalUrl = useCallback(
    async (url: string) => {
      try {
        await openExternalUrl(url);
      } catch (err) {
        setActionNotice(
          err instanceof Error ? err.message : "Failed to open external link.",
          "error",
          4200,
        );
      }
    },
    [setActionNotice],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, pluginId: string) => {
      dragRef.current = pluginId;
      setDraggingId(pluginId);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", pluginId);
    },
    [],
  );

  const handleDragOver = useCallback((e: React.DragEvent, pluginId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragRef.current && dragRef.current !== pluginId) {
      setDragOverId(pluginId);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      const srcId = dragRef.current;
      if (!srcId || srcId === targetId) {
        dragRef.current = null;
        setDraggingId(null);
        setDragOverId(null);
        return;
      }
      // Materialize current sorted order, then splice
      if (!allowCustomOrder) {
        dragRef.current = null;
        setDraggingId(null);
        setDragOverId(null);
        return;
      }
      setPluginOrder(() => {
        // Build full order: items in custom order first, then any new ones
        const allIds = nonDbPlugins.map((p: PluginInfo) => p.id);
        let ids: string[];
        if (pluginOrder.length > 0) {
          const known = new Set(pluginOrder);
          ids = [...pluginOrder, ...allIds.filter((id) => !known.has(id))];
        } else {
          ids = sorted.map((p: PluginInfo) => p.id);
          // Pad with any nonDbPlugins not currently in sorted (due to filters)
          const inSorted = new Set(ids);
          for (const id of allIds) {
            if (!inSorted.has(id)) ids.push(id);
          }
        }
        const fromIdx = ids.indexOf(srcId);
        const toIdx = ids.indexOf(targetId);
        if (fromIdx === -1 || toIdx === -1) return ids;
        ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, srcId);
        return ids;
      });
      dragRef.current = null;
      setDraggingId(null);
      setDragOverId(null);
    },
    [allowCustomOrder, nonDbPlugins, pluginOrder, sorted],
  );

  const handleDragEnd = useCallback(() => {
    dragRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  const handleResetOrder = useCallback(() => {
    setPluginOrder([]);
    localStorage.removeItem("pluginOrder");
  }, []);

  const { ref: resetOrderRef, agentProps: resetOrderAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "reset-plugin-order",
      role: "button",
      label: t("pluginsview.ResetOrder"),
      group: "plugin-actions",
      description: "Reset the custom plugin ordering to the default sort",
      onActivate: handleResetOrder,
    });

  const renderResolvedIcon = useCallback(
    (
      plugin: PluginInfo,
      options?: {
        className?: string;
        emojiClassName?: string;
      },
    ) => {
      const icon = resolveIcon(plugin);
      if (!icon) {
        return <Puzzle className={options?.className ?? "w-5 h-5"} />;
      }
      if (typeof icon === "string") {
        const imageSrc = iconImageSource(icon);
        return imageSrc ? (
          <img
            src={imageSrc}
            alt=""
            className={
              options?.className ?? "w-5 h-5 rounded-sm object-contain"
            }
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <Puzzle className={options?.className ?? "w-5 h-5"} />
        );
      }
      const IconComponent = icon;
      return <IconComponent className={options?.className ?? "w-5 h-5"} />;
    },
    [],
  );

  /** Render plugins as flat rows separated by a single hairline divider. */
  const renderPluginGrid = (plugins: PluginInfo[]) => (
    <ul className="m-0 flex list-none flex-col divide-y divide-border/40 p-0">
      {plugins.map((p: PluginInfo) => (
        <PluginCard
          key={p.id}
          plugin={p}
          allowCustomOrder={allowCustomOrder}
          pluginSettingsOpen={pluginSettingsOpen}
          togglingPlugins={togglingPlugins}
          hasPluginToggleInFlight={hasPluginToggleInFlight}
          installingPlugins={installingPlugins}
          updatingPlugins={updatingPlugins}
          uninstallingPlugins={uninstallingPlugins}
          installProgress={installProgress}
          releaseStreamSelections={pluginReleaseStreams}
          draggingId={draggingId}
          dragOverId={dragOverId}
          pluginDescriptionFallback={pluginDescriptionFallback}
          onToggle={handleTogglePlugin}
          onToggleSettings={toggleSettings}
          onInstall={handleInstallPlugin}
          onUpdate={handleUpdatePlugin}
          onUninstall={handleUninstallPlugin}
          onReleaseStreamChange={handleReleaseStreamChange}
          onOpenExternalUrl={handleOpenPluginExternalUrl}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
          installProgressLabel={installProgressLabel}
          installLabel={installLabel}
          loadFailedLabel={loadFailedLabel}
          notInstalledLabel={notInstalledLabel}
        />
      ))}
    </ul>
  );

  /**
   * Render plugins split into labeled subgroup sections (light uppercase
   * labels between grids). Used when the "All" filter chip is active so the
   * single pane keeps section context without a nav sidebar.
   */
  const groupedVisiblePlugins = useMemo(() => {
    const groupMap = new Map<string, PluginInfo[]>();
    for (const plugin of visiblePlugins) {
      const groupId = subgroupForPlugin(plugin);
      const bucket = groupMap.get(groupId);
      if (bucket) bucket.push(plugin);
      else groupMap.set(groupId, [plugin]);
    }
    const orderedGroups = SUBGROUP_DISPLAY_ORDER.filter((id) =>
      groupMap.has(id),
    );
    for (const id of groupMap.keys()) {
      if (
        !orderedGroups.includes(id as (typeof SUBGROUP_DISPLAY_ORDER)[number])
      )
        orderedGroups.push(id as (typeof SUBGROUP_DISPLAY_ORDER)[number]);
    }
    return orderedGroups.map((groupId) => ({
      groupId,
      plugins: groupMap.get(groupId) ?? [],
    }));
  }, [visiblePlugins]);

  const renderGroupedPlugins = () => (
    <div className="space-y-6">
      {groupedVisiblePlugins.map(({ groupId, plugins: groupPlugins }) => {
        if (groupPlugins.length === 0) return null;
        return (
          <section key={groupId}>
            <h3 className="mb-3 text-sm font-medium text-txt-strong">
              {SUBGROUP_LABELS[groupId] ?? groupId}
            </h3>
            {renderPluginGrid(groupPlugins)}
          </section>
        );
      })}
    </div>
  );

  // Resolve the plugin whose settings dialog is currently open.
  // Exclude ai-provider plugins — those are configured in Settings.
  const settingsDialogPlugin =
    Array.from(pluginSettingsOpen)
      .map((id) => nonDbPlugins.find((plugin) => plugin.id === id) ?? null)
      .find((plugin) => (plugin?.parameters?.length ?? 0) > 0) ?? null;
  const [gameSelectedId, setGameSelectedId] = useState<string | null>(null);
  const [gameMobileDetail, setGameMobileDetail] = useState(false);
  const gameNarrow =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 600px)").matches
      : false;
  const readDesktopConnectorLayout = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 1024px)").matches
      : false;
  const initialDesktopConnectorLayout = readDesktopConnectorLayout();
  const [connectorExpandedIds, setConnectorExpandedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [connectorSelectedId, setConnectorSelectedId] = useState<string | null>(
    () =>
      isSidebarEditorShellMode && initialDesktopConnectorLayout
        ? (visiblePlugins[0]?.id ?? null)
        : null,
  );
  const [desktopConnectorLayout, setDesktopConnectorLayout] = useState(
    initialDesktopConnectorLayout,
  );
  const {
    contentContainerRef: connectorContentRef,
    queueContentAlignment: queueConnectorContentAlignment,
    registerContentItem: registerConnectorContentItem,
    scrollContentToItem: scrollConnectorIntoView,
  } = useLinkedSidebarSelection<string>({
    contentTopOffset: 0,
    enabled: isSidebarEditorShellMode,
    selectedId: connectorSelectedId,
    topAlignedId: visiblePlugins[0]?.id ?? null,
  });

  // Auto-select first visible plugin in game modal
  const gameVisiblePlugins = visiblePlugins.filter(
    (p: PluginInfo) => p.id !== "__ui-showcase__",
  );
  const effectiveGameSelected = gameVisiblePlugins.find(
    (p: PluginInfo) => p.id === gameSelectedId,
  )
    ? gameSelectedId
    : (gameVisiblePlugins[0]?.id ?? null);
  const selectedPlugin =
    gameVisiblePlugins.find(
      (p: PluginInfo) => p.id === effectiveGameSelected,
    ) ?? null;
  const selectedPluginLinks = selectedPlugin
    ? getPluginResourceLinks(selectedPlugin, {
        draftConfig: pluginConfigs[selectedPlugin.id],
      })
    : [];

  useEffect(() => {
    if (!isConnectorShellMode) return;
    if (pluginStatusFilter !== "disabled") return;
    setState("pluginStatusFilter", "all");
  }, [isConnectorShellMode, pluginStatusFilter, setState]);

  useEffect(() => {
    if (!isSidebarEditorShellMode) return;
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;

    const media = window.matchMedia("(min-width: 1024px)");
    const syncLayout = () => {
      setDesktopConnectorLayout(media.matches);
    };

    syncLayout();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", syncLayout);
      return () => media.removeEventListener("change", syncLayout);
    }

    media.addListener(syncLayout);
    return () => media.removeListener(syncLayout);
  }, [isSidebarEditorShellMode]);

  useEffect(() => {
    if (!isSidebarEditorShellMode) return;
    if (visiblePlugins.length === 0) {
      setConnectorSelectedId(null);
      setConnectorExpandedIds(new Set());
      return;
    }

    setConnectorSelectedId((prev) => {
      if (visiblePlugins.some((plugin) => plugin.id === prev)) {
        return prev;
      }
      return desktopConnectorLayout ? (visiblePlugins[0]?.id ?? null) : null;
    });
    setConnectorExpandedIds((prev) => {
      const next = new Set(
        [...prev].filter((id) =>
          visiblePlugins.some((plugin) => plugin.id === id),
        ),
      );
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [desktopConnectorLayout, isSidebarEditorShellMode, visiblePlugins]);

  const _handleConnectorSelect = useCallback(
    (pluginId: string) => {
      setConnectorSelectedId(pluginId);
      if (desktopConnectorLayout) {
        setConnectorExpandedIds(new Set([pluginId]));
        queueConnectorContentAlignment(pluginId);
      } else {
        scrollConnectorIntoView(pluginId);
      }
    },
    [
      desktopConnectorLayout,
      queueConnectorContentAlignment,
      scrollConnectorIntoView,
    ],
  );

  const handleConnectorExpandedChange = useCallback(
    (pluginId: string, nextExpanded: boolean) => {
      setConnectorSelectedId(pluginId);
      if (desktopConnectorLayout) {
        setConnectorExpandedIds((prev) => {
          if (nextExpanded) {
            if (prev.size === 1 && prev.has(pluginId)) return prev;
            return new Set([pluginId]);
          }
          if (!prev.has(pluginId)) return prev;
          return new Set();
        });
        if (nextExpanded) {
          queueConnectorContentAlignment(pluginId);
        }
        return;
      }

      setConnectorExpandedIds((prev) => {
        const isExpanded = prev.has(pluginId);
        if (isExpanded === nextExpanded) return prev;
        const next = new Set(prev);
        if (nextExpanded) next.add(pluginId);
        else next.delete(pluginId);
        return next;
      });
      if (nextExpanded) {
        scrollConnectorIntoView(pluginId);
      }
    },
    [
      desktopConnectorLayout,
      queueConnectorContentAlignment,
      scrollConnectorIntoView,
    ],
  );

  const handleConnectorSectionToggle = useCallback(
    (pluginId: string) => {
      handleConnectorExpandedChange(
        pluginId,
        !connectorExpandedIds.has(pluginId),
      );
    },
    [connectorExpandedIds, handleConnectorExpandedChange],
  );

  if (isSidebarEditorShellMode) {
    const shellEmptyTitle =
      mode === "social" ? "No connectors available" : "No plugins available";
    const shellEmptyDescription =
      mode === "social"
        ? "This workspace will list connector integrations as they become available."
        : "This workspace will list plugins here as they become available.";
    const hasActivePluginFilters =
      pluginSearch.trim().length > 0 || subgroupFilter !== "all";
    const connectorContent = (
      <div className="w-full">
        <ChatSearchHint noun="plugins" query={pluginSearch} className="mb-4" />
        {hasPluginToggleInFlight && (
          <PagePanel.Notice tone="accent" className="mb-4 text-xs-tight">
            {t("pluginsview.ApplyingPluginChan")}
          </PagePanel.Notice>
        )}

        {visiblePlugins.length === 0 ? (
          <PagePanel.Empty
            variant="surface"
            className="min-h-[18rem] rounded-sm px-5 py-10"
            description={
              hasActivePluginFilters
                ? `Try a different search or category filter for ${resultLabel}.`
                : shellEmptyDescription
            }
            title={
              hasActivePluginFilters
                ? `No ${resultLabel} match your filters`
                : shellEmptyTitle
            }
          />
        ) : (
          <div data-testid="connectors-settings-content" className="space-y-1">
            <ConnectorPluginGroups
              collapseLabel={collapseLabel}
              connectorExpandedIds={connectorExpandedIds}
              connectorInstallPrompt={connectorInstallPrompt}
              connectorSelectedId={connectorSelectedId}
              expandLabel={expandLabel}
              formatSaveSettingsLabel={formatSaveSettingsLabel}
              formatTestConnectionLabel={formatTestConnectionLabel}
              handleConfigReset={handleConfigReset}
              handleConfigSave={handleConfigSave}
              handleConnectorExpandedChange={handleConnectorExpandedChange}
              handleConnectorSectionToggle={handleConnectorSectionToggle}
              handleInstallPlugin={handleInstallPlugin}
              handleOpenPluginExternalUrl={handleOpenPluginExternalUrl}
              handleParamChange={handleParamChange}
              handleTestConnection={handleTestConnection}
              handleTogglePlugin={handleTogglePlugin}
              hasPluginToggleInFlight={hasPluginToggleInFlight}
              installPluginLabel={installPluginLabel}
              installProgress={installProgress}
              installProgressLabel={installProgressLabel}
              installingPlugins={installingPlugins}
              loadFailedLabel={loadFailedLabel}
              needsSetupLabel={needsSetupLabel}
              noConfigurationNeededLabel={noConfigurationNeededLabel}
              notInstalledLabel={notInstalledLabel}
              pluginConfigs={pluginConfigs}
              pluginDescriptionFallback={pluginDescriptionFallback}
              pluginSaveSuccess={pluginSaveSuccess}
              pluginSaving={pluginSaving}
              readyLabel={readyLabel}
              registerConnectorContentItem={registerConnectorContentItem}
              renderResolvedIcon={renderResolvedIcon}
              t={t}
              testResults={testResults}
              togglingPlugins={togglingPlugins}
              visiblePlugins={visiblePlugins}
            />
          </div>
        )}
      </div>
    );

    return (
      <main
        ref={connectorContentRef}
        className="chat-native-scrollbar relative flex flex-1 min-w-0 flex-col overflow-x-hidden overflow-y-auto bg-transparent px-4 pb-4 pt-2 sm:px-6 sm:pb-6 sm:pt-3 lg:px-7 lg:pb-7 lg:pt-4"
      >
        {contentHeader ? (
          <PageLayoutHeader>{contentHeader}</PageLayoutHeader>
        ) : null}
        {connectorContent}
      </main>
    );
  }

  if (inModal) {
    return (
      <PluginGameModal
        effectiveGameSelected={effectiveGameSelected}
        gameMobileDetail={gameMobileDetail}
        gameNarrow={gameNarrow}
        gameVisiblePlugins={gameVisiblePlugins}
        isConnectorLikeMode={isConnectorLikeMode}
        pluginConfigs={pluginConfigs}
        pluginSaveSuccess={pluginSaveSuccess}
        pluginSaving={pluginSaving}
        resultLabel={resultLabel}
        saveLabel={saveLabel}
        savedLabel={savedWithBangLabel}
        savingLabel={savingLabel}
        sectionTitle={mode === "connectors" ? "Connectors" : label}
        selectedPlugin={selectedPlugin}
        selectedPluginLinks={selectedPluginLinks}
        t={t}
        togglingPlugins={togglingPlugins}
        onBack={() => setGameMobileDetail(false)}
        onConfigSave={handleConfigSave}
        onOpenExternalUrl={handleOpenPluginExternalUrl}
        onParamChange={handleParamChange}
        onSelectPlugin={(pluginId) => {
          setGameSelectedId(pluginId);
          if (gameNarrow) setGameMobileDetail(true);
        }}
        onTestConnection={handleTestConnection}
        onTogglePlugin={handleTogglePlugin}
      />
    );
  }

  const selectedSubgroupTag =
    subgroupTags.find((tag) => tag.id === subgroupFilter) ?? subgroupTags[0];
  const pluginSectionTitle =
    selectedSubgroupTag?.id === "all"
      ? t("pluginsview.PluginCatalog", { defaultValue: "Plugin Catalog" })
      : (selectedSubgroupTag?.label ??
        t("pluginsview.PluginCatalog", { defaultValue: "Plugin Catalog" }));

  const isAllFilter = subgroupFilter === "all";

  return (
    <PagePanel.Frame data-testid="plugins-view-page">
      <PagePanel
        as="div"
        variant="shell"
        className="settings-shell flex-col"
        data-testid="plugins-shell"
      >
        <PagePanel.ContentArea>
          <main className="chat-native-scrollbar flex h-full flex-col overflow-y-auto px-4 pb-32 pt-5 sm:px-6 lg:px-8">
            <header className="mb-5">
              <h1 className="text-2xl font-semibold tracking-tight text-txt">
                {pluginSectionTitle}
              </h1>

              <ChatSearchHint
                noun="plugins"
                query={pluginSearch}
                className="mt-2"
              />

              {showSubgroupFilters && subgroupTags.length > 1 && (
                <div
                  className="mt-4 flex flex-wrap items-center gap-2"
                  data-testid="plugins-subgroup-chips"
                >
                  {subgroupTags.map((tag) => renderSubgroupFilterButton(tag))}
                  {allowCustomOrder && pluginOrder.length > 0 && (
                    <Button
                      ref={resetOrderRef}
                      variant="outline"
                      size="sm"
                      className="ml-1 min-h-11 rounded-full px-3 text-2xs font-bold tracking-wide text-muted hover:text-txt"
                      onClick={handleResetOrder}
                      title={t("pluginsview.ResetToDefaultSor")}
                      {...resetOrderAgentProps}
                    >
                      {t("pluginsview.ResetOrder")}
                    </Button>
                  )}
                </div>
              )}
            </header>

            {hasPluginToggleInFlight && (
              <PagePanel.Notice tone="accent" className="mb-4 text-xs-tight">
                {t("pluginsview.ApplyingPluginChan")}
              </PagePanel.Notice>
            )}

            {sorted.length === 0 && isLoadingPlugins ? (
              <PagePanel.Loading
                variant="surface"
                className="min-h-[18rem] rounded-lg px-5 py-10"
                heading={t("pluginsview.LoadingTitle", {
                  defaultValue: "Loading {{label}}…",
                  label: label.toLowerCase(),
                })}
              />
            ) : sorted.length === 0 && pluginsLoadError ? (
              <PagePanel.Empty
                variant="surface"
                className="min-h-[18rem] rounded-lg px-5 py-10"
                description={t("pluginsview.LoadFailedDesc", {
                  defaultValue:
                    "Couldn't load {{label}}: {{error}}. Check your connection and try again.",
                  label: resultLabel,
                  error: pluginsLoadError,
                })}
                title={t("pluginsview.LoadFailedTitle", {
                  defaultValue: "Couldn't load {{label}}",
                  label: label.toLowerCase(),
                })}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void loadPlugins();
                    }}
                  >
                    {t("pluginsview.Retry", { defaultValue: "Retry" })}
                  </Button>
                }
              />
            ) : sorted.length === 0 && pluginsLoaded ? (
              <PagePanel.Empty
                variant="surface"
                className="min-h-[18rem] rounded-lg px-5 py-10"
                description={t("pluginsview.NoneAvailableDesc", {
                  defaultValue: "No {{label}} are available right now.",
                  label: resultLabel,
                })}
                title={t("pluginsview.NoneAvailableTitle", {
                  defaultValue: "No {{label}} available",
                  label: label.toLowerCase(),
                })}
              />
            ) : sorted.length === 0 ? (
              <PagePanel.Loading
                variant="surface"
                className="min-h-[18rem] rounded-lg px-5 py-10"
                heading={t("pluginsview.LoadingTitle", {
                  defaultValue: "Loading {{label}}…",
                  label: label.toLowerCase(),
                })}
              />
            ) : visiblePlugins.length === 0 ? (
              <PagePanel.Empty
                variant="surface"
                className="min-h-[16rem] rounded-lg px-5 py-10"
                description={
                  showSubgroupFilters
                    ? t("pluginsview.NoPluginsMatchCategory", {
                        defaultValue: "No plugins match the selected category.",
                      })
                    : t("pluginsview.NoPluginsMatchFilters", {
                        defaultValue: "No {{label}} match your filters.",
                        label: resultLabel,
                      })
                }
                title={t("pluginsview.NothingToShow", {
                  defaultValue: "Nothing to show",
                })}
              />
            ) : isAllFilter && !pluginSearch.trim() ? (
              renderGroupedPlugins()
            ) : (
              renderPluginGrid(visiblePlugins)
            )}
          </main>
        </PagePanel.ContentArea>
        <PluginSettingsDialog
          installPluginLabel={installPluginLabel}
          installProgress={installProgress}
          installingPlugins={installingPlugins}
          pluginConfigs={pluginConfigs}
          pluginSaveSuccess={pluginSaveSuccess}
          pluginSaving={pluginSaving}
          settingsDialogPlugin={settingsDialogPlugin}
          t={t}
          testResults={testResults}
          onClose={toggleSettings}
          onConfigReset={handleConfigReset}
          onConfigSave={handleConfigSave}
          onInstallPlugin={handleInstallPlugin}
          onParamChange={handleParamChange}
          onTestConnection={handleTestConnection}
          formatDialogTestConnectionLabel={formatDialogTestConnectionLabel}
          installProgressLabel={installProgressLabel}
          saveSettingsLabel={saveSettingsLabel}
          savingLabel={savingLabel}
        />
      </PagePanel>
    </PagePanel.Frame>
  );
}

/* ── Exported views ────────────────────────────────────────────────── */

/** Plugins view — tag-filtered plugin list. */
export function PluginsView({
  contentHeader,
  mode = "all",
  inModal,
  connectorDesktopPlacement = "left",
}: {
  contentHeader?: ReactNode;
  mode?: PluginsViewMode;
  inModal?: boolean;
  connectorDesktopPlacement?: "left" | "right";
}) {
  useRenderGuard("PluginsView");
  const label =
    mode === "social"
      ? "Connectors"
      : mode === "connectors"
        ? "Connectors"
        : mode === "streaming"
          ? "Streaming"
          : mode === "all-social"
            ? "Plugins"
            : "Plugins";
  return (
    <PluginListView
      contentHeader={contentHeader}
      connectorDesktopPlacement={connectorDesktopPlacement}
      label={label}
      mode={mode}
      inModal={inModal}
    />
  );
}
