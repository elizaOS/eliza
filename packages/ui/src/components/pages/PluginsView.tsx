import { Package } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PluginInfo } from "../../api";
import { client } from "../../api";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";

import {
  buildPluginListState,
  getPluginResourceLinks,
  iconImageSource,
  type PluginsViewMode,
  resolveIcon,
  type StatusFilter,
  SUBGROUP_NAV_ICONS,
} from "./plugin-list-utils";

export { paramsToSchema } from "./plugin-list-utils";

import { Button } from "../ui/button";
import { PageLayoutHeader } from "../../layouts/page-layout/page-layout-header";
import { PagePanel } from "../composites/page-panel";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { useLinkedSidebarSelection } from "../../hooks/useLinkedSidebarSelection";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { PluginCard } from "./PluginCard";
import {
  ConnectorPluginGroups,
  type PluginConnectionTestResult,
} from "./plugin-view-connectors";
import { PluginSettingsDialog } from "./plugin-view-dialogs";
import { PluginGameModal } from "./plugin-view-modal";
import { ConnectorSidebar } from "./plugin-view-sidebar";

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
    loadPlugins,
    ensurePluginsLoaded = async () => {
      await loadPlugins();
    },
    handlePluginToggle,
    handlePluginConfigSave,
    setActionNotice,
    setState,
    t,
  } = useApp();

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
        defaultValue: "✓ OK ({{durationMs}}ms)",
      });
    }
    if (result?.error) {
      return t("pluginsview.ConnectionTestFailedDialog", {
        error: result.error,
        defaultValue: "✕ {{error}}",
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
  const isSocialMode = mode === "social" || mode === "all-social";
  const isSidebarEditorShellMode = mode === "social" || mode === "all-social";
  const isConnectorLikeMode = mode === "connectors" || mode === "social";
  const resultLabel = mode === "social" ? "connectors" : label.toLowerCase();
  const effectiveStatusFilter: StatusFilter = isSidebarEditorShellMode
    ? pluginStatusFilter
    : "all";
  const effectiveSearch = isSidebarEditorShellMode ? pluginSearch : "";

  const allowCustomOrder = !isSocialMode;

  // Load plugins on mount
  useEffect(() => {
    void ensurePluginsLoaded();
  }, [ensurePluginsLoaded]);

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
  const showDesktopSubgroupSidebar = showSubgroupFilters;
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
    (
      tag: { id: string; label: string; count: number },
      options?: { sidebar?: boolean },
    ) => {
      const isActive = subgroupFilter === tag.id;
      if (options?.sidebar) {
        const Icon = SUBGROUP_NAV_ICONS[tag.id] ?? Package;
        return (
          <SidebarContent.Item
            key={tag.id}
            as="button"
            onClick={() => setSubgroupFilter(tag.id)}
            aria-current={isActive ? "page" : undefined}
            active={isActive}
            className="items-center"
          >
            <SidebarContent.ItemIcon active={isActive}>
              <Icon className="h-4 w-4" />
            </SidebarContent.ItemIcon>
            <SidebarContent.ItemBody>
              <SidebarContent.ItemTitle className="whitespace-nowrap break-normal [overflow-wrap:normal]">
                {tag.label}
              </SidebarContent.ItemTitle>
              <SidebarContent.ItemDescription>
                {t("pluginsview.AvailableCount", {
                  count: tag.count,
                  defaultValue: "{{count}} available",
                })}
              </SidebarContent.ItemDescription>
            </SidebarContent.ItemBody>
            <PagePanel.Meta
              compact
              tone={isActive ? "accent" : "default"}
              className="text-2xs font-bold tracking-[0.16em]"
            >
              {tag.count}
            </PagePanel.Meta>
          </SidebarContent.Item>
        );
      }

      return (
        <Button
          key={tag.id}
          variant={isActive ? "default" : "outline"}
          size="sm"
          className={`h-7 px-3 text-xs-tight font-bold tracking-wide rounded-[var(--radius-md)] transition-all ${
            isActive
              ? "border-accent/55 bg-accent/16 text-txt-strong shadow-sm"
              : "bg-card/40 backdrop-blur-sm border-border/40 text-muted hover:text-txt shadow-sm hover:border-accent/30"
          }`}
          onClick={() => setSubgroupFilter(tag.id)}
        >
          {tag.label}
          <span
            className={`ml-1.5 rounded border px-1.5 py-0.5 text-3xs font-mono leading-none ${
              isActive
                ? "border-accent/30 bg-accent/12 text-txt-strong"
                : "border-border/50 bg-bg-accent/80 text-muted-strong"
            }`}
          >
            {tag.count}
          </span>
        </Button>
      );
    },
    [subgroupFilter, t],
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
    await handlePluginConfigSave(pluginId, config);
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
      // Still try to refresh in case install succeeded but restart failed
      try {
        await loadPlugins();
      } catch {
        /* ignore */
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
        /* ignore */
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
        /* ignore */
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
      if (!allowCustomOrder) return;
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
        return <span className={options?.emojiClassName ?? "text-sm"}>🧩</span>;
      }
      if (typeof icon === "string") {
        const imageSrc = iconImageSource(icon);
        return imageSrc ? (
          <img
            src={imageSrc}
            alt=""
            className={
              options?.className ??
              "w-5 h-5 rounded-[var(--radius-sm)] object-contain"
            }
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <span className={options?.emojiClassName ?? "text-sm"}>{icon}</span>
        );
      }
      const IconComponent = icon;
      return <IconComponent className={options?.className ?? "w-5 h-5"} />;
    },
    [],
  );

  /** Render a grid of plugin cards. */
  const renderPluginGrid = (plugins: PluginInfo[]) => (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 m-0 p-0 list-none">
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
    registerRailItem: registerConnectorRailItem,
    registerSidebarItem: registerConnectorSidebarItem,
    registerSidebarViewport: registerConnectorSidebarViewport,
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

  const handleConnectorSelect = useCallback(
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
    const _desktopSidebar = (
      <ConnectorSidebar
        collapseLabel={collapseLabel}
        connectorExpandedIds={connectorExpandedIds}
        connectorSelectedId={connectorSelectedId}
        desktopConnectorLayout={desktopConnectorLayout}
        expandLabel={expandLabel}
        hasPluginToggleInFlight={hasPluginToggleInFlight}
        mode={mode}
        onConnectorSelect={handleConnectorSelect}
        onConnectorSectionToggle={handleConnectorSectionToggle}
        onSearchChange={(value: string) => setState("pluginSearch", value)}
        onSearchClear={() => setState("pluginSearch", "")}
        onSubgroupFilterChange={(value: string) => setSubgroupFilter(value)}
        onTogglePlugin={handleTogglePlugin}
        pluginSearch={pluginSearch}
        registerConnectorRailItem={registerConnectorRailItem}
        registerConnectorSidebarItem={registerConnectorSidebarItem}
        registerConnectorSidebarViewport={registerConnectorSidebarViewport}
        renderResolvedIcon={renderResolvedIcon}
        resultLabel={resultLabel}
        subgroupFilter={subgroupFilter}
        subgroupTags={subgroupTags}
        t={t}
        togglingPlugins={togglingPlugins}
        visiblePlugins={visiblePlugins}
      />
    );

    const connectorContent = (
      <div className="w-full">
        {hasPluginToggleInFlight && (
          <PagePanel.Notice tone="accent" className="mb-4 text-xs-tight">
            {t("pluginsview.ApplyingPluginChan")}
          </PagePanel.Notice>
        )}

        {visiblePlugins.length === 0 ? (
          <PagePanel.Empty
            variant="surface"
            className="min-h-[18rem] rounded-[1.6rem] px-5 py-10"
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

  return (
    <PagePanel.Frame data-testid="plugins-view-page">
      <PagePanel
        as="div"
        variant="shell"
        className="settings-shell plugins-game-modal plugins-game-modal--inline flex-col lg:flex-row"
        data-testid="plugins-shell"
      >
        {showDesktopSubgroupSidebar && (
          <AppPageSidebar
            className="hidden lg:flex"
            testId="plugins-subgroup-sidebar"
            collapsible
            contentIdentity="plugins-subgroups"
            aria-label={t("pluginsview.PluginTypes", {
              defaultValue: "Plugin types",
            })}
            collapsedRailItems={subgroupTags.map((tag) => {
              const Icon = SUBGROUP_NAV_ICONS[tag.id] ?? Package;
              const isActive = subgroupFilter === tag.id;
              return (
                <SidebarContent.RailItem
                  key={tag.id}
                  aria-label={tag.label}
                  title={tag.label}
                  active={isActive}
                  onClick={() => setSubgroupFilter(tag.id)}
                >
                  <Icon className="h-4 w-4" />
                </SidebarContent.RailItem>
              );
            })}
          >
            <SidebarScrollRegion className="pt-4">
              <SidebarPanel>
                {subgroupTags.map((tag) =>
                  renderSubgroupFilterButton(tag, { sidebar: true }),
                )}
              </SidebarPanel>
            </SidebarScrollRegion>
          </AppPageSidebar>
        )}

        <PagePanel.ContentArea>
          <div className="px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6">
            <PagePanel variant="section">
              {!isConnectorShellMode && (
                <PagePanel.Header
                  eyebrow={t("nav.advanced")}
                  heading={pluginSectionTitle}
                  className="border-border/35"
                  actions={
                    <PagePanel.Meta className="border-border/45 px-2.5 py-1 font-bold tracking-[0.16em] text-muted">
                      {t("pluginsview.VisibleCount", {
                        defaultValue: "{{count}} shown",
                        count: visiblePlugins.length,
                      })}
                    </PagePanel.Meta>
                  }
                />
              )}

              <div className="bg-bg/18 px-4 py-4 sm:px-5">
                {allowCustomOrder && pluginOrder.length > 0 ? (
                  <div className="mb-4 flex flex-wrap items-center gap-3">
                    {allowCustomOrder && pluginOrder.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 rounded-[var(--radius-sm)] px-4 text-xs-tight font-bold tracking-[0.12em]"
                        onClick={handleResetOrder}
                        title={t("pluginsview.ResetToDefaultSor")}
                      >
                        {t("pluginsview.ResetOrder")}
                      </Button>
                    )}
                  </div>
                ) : null}

                {hasPluginToggleInFlight && (
                  <PagePanel.Notice
                    tone="accent"
                    className="mb-4 text-xs-tight"
                  >
                    {t("pluginsview.ApplyingPluginChan")}
                  </PagePanel.Notice>
                )}

                {showSubgroupFilters && (
                  <div
                    className="mb-5 flex items-center gap-2 flex-wrap lg:hidden"
                    data-testid="plugins-subgroup-chips"
                  >
                    {subgroupTags.map((tag) => renderSubgroupFilterButton(tag))}
                  </div>
                )}

                <div className="overflow-y-auto">
                  {sorted.length === 0 ? (
                    <PagePanel.Empty
                      variant="surface"
                      className="min-h-[18rem] rounded-[1.6rem] px-5 py-10"
                      description={t("pluginsview.NoneAvailableDesc", {
                        defaultValue: "No {{label}} are available right now.",
                        label: resultLabel,
                      })}
                      title={t("pluginsview.NoneAvailableTitle", {
                        defaultValue: "No {{label}} available",
                        label: label.toLowerCase(),
                      })}
                    />
                  ) : visiblePlugins.length === 0 ? (
                    <PagePanel.Empty
                      variant="surface"
                      className="min-h-[16rem] rounded-[1.6rem] px-5 py-10"
                      description={
                        showSubgroupFilters
                          ? t("pluginsview.NoPluginsMatchCategory", {
                              defaultValue:
                                "No plugins match the selected category.",
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
                  ) : (
                    renderPluginGrid(visiblePlugins)
                  )}
                </div>
              </div>
            </PagePanel>
          </div>
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
