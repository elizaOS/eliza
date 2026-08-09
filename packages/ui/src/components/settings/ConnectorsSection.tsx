/**
 * Settings → Connectors: index list (Delegate/Bot lens + grouped rows) and
 * per-connector detail pages (`#connectors/<id>`). Setup lives on the detail
 * surface — Connection / Support / General cards — not inline accordions.
 */

import {
  ChevronRight,
  type LucideIcon,
  type LucideProps,
  Puzzle,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAgentElement } from "../../agent-surface";
import type { PluginInfo } from "../../api";
import {
  clearPendingFocusConnector,
  FOCUS_CONNECTOR_EVENT,
  type FocusConnectorEventDetail,
  readPendingFocusConnector,
} from "../../events";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import {
  ConnectorChannelModeSwitch,
  connectorChannelModeCopy,
} from "../connectors/ConnectorChannelModeSwitch";
import { ConnectorModeSelector } from "../connectors/ConnectorModeSelector";
import type { ConnectorMode } from "../connectors/ConnectorModeSelector.helpers";
import { useConnectorMode } from "../connectors/ConnectorModeSelector.hooks";
import { ConnectorSetupPanel } from "../connectors/ConnectorSetupPanel";
import { hasConnectorSetupPanel } from "../connectors/ConnectorSetupPanel.helpers";
import {
  type ConnectorChannelMode,
  setConnectorChannelMode,
  useConnectorChannelMode,
} from "../connectors/connector-channel-mode";
import {
  connectorSupportsChannelMode,
  getConnectorModeConfigFormHint,
  getConnectorModeHiddenConfigKeys,
} from "../connectors/connector-mode-registry";
import {
  CONNECTOR_UI_GROUPS,
  connectorStatusLabel,
  getConnectorUiGroupId,
} from "../connectors/connector-ui-groups";
import { getBrandIcon } from "../conversations/brand-icons";
import { PluginConfigForm } from "../pages/PluginConfigForm";
import {
  ALWAYS_ON_PLUGIN_IDS,
  getPluginResourceLinks,
  iconImageSource,
  pluginResourceLinkLabel,
  resolveIcon,
} from "../pages/plugin-list-utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  normalizeConnectorRouteId,
  openConnectorDetailHash,
  openConnectorsIndexHash,
  readSettingsHashRoute,
  replaceConnectorDetailHash,
  type SettingsRoute,
} from "./settings-route";

/**
 * Whether Settings → Connectors should render the generic plugin-config (env
 * credential) form for the selected connector mode.
 */
export function getConnectorSurfaceOwnedConfigKeys(
  plugin: Pick<PluginInfo, "parameters">,
): string[] {
  return plugin.parameters
    .filter(
      (parameter) =>
        parameter.description.trim().toLowerCase() ===
        "enable or disable this feature",
    )
    .map((parameter) => parameter.key);
}

export function shouldRenderConnectorConfigForm(args: {
  managementMode: ConnectorMode["managementMode"] | undefined;
  hasParameters: boolean;
  setupTargetsPlugin: boolean;
}): boolean {
  return (
    (args.managementMode === "local-config" ||
      args.managementMode === undefined) &&
    args.hasParameters &&
    args.setupTargetsPlugin
  );
}

function subscribeHash(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("hashchange", onStoreChange);
  window.addEventListener("popstate", onStoreChange);
  return () => {
    window.removeEventListener("hashchange", onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
  };
}

// useSyncExternalStore requires a stable getSnapshot reference equality when
// the underlying store has not changed — parse once per hash string.
let cachedRouteHash = "\0";
let cachedRoute: SettingsRoute = { kind: "hub" };
const SERVER_ROUTE: SettingsRoute = { kind: "hub" };

function getSettingsRouteSnapshot(): SettingsRoute {
  if (typeof window === "undefined") return SERVER_ROUTE;
  const hash = window.location.hash;
  if (hash === cachedRouteHash) return cachedRoute;
  cachedRouteHash = hash;
  cachedRoute = readSettingsHashRoute();
  return cachedRoute;
}

function useSettingsRoute(): SettingsRoute {
  return useSyncExternalStore(
    subscribeHash,
    getSettingsRouteSnapshot,
    () => SERVER_ROUTE,
  );
}

function connectorIcon(plugin: PluginInfo): LucideIcon {
  const Brand = getBrandIcon(plugin.id);
  const icon = resolveIcon(plugin);
  const imageSrc = typeof icon === "string" ? iconImageSource(icon) : undefined;
  const Inner = typeof icon === "string" || !icon ? null : icon;
  return forwardRef<SVGSVGElement, LucideProps>(function ConnectorMedallionIcon(
    { className },
    ref,
  ) {
    if (Brand) return <Brand className={className} />;
    if (imageSrc)
      return (
        <img
          src={imageSrc}
          alt=""
          className="h-[18px] w-[18px] shrink-0 rounded-sm object-contain"
        />
      );
    const IconComponent = Inner;
    if (IconComponent) return <IconComponent ref={ref} className={className} />;
    return <Puzzle ref={ref} className={className} aria-hidden />;
  });
}

function statusToneClass(tone: "ok" | "warn" | "muted" | "danger"): string {
  switch (tone) {
    case "ok":
      return "text-ok";
    case "warn":
      return "text-warn";
    case "danger":
      return "text-danger";
    default:
      return "text-muted";
  }
}

function SettingsCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border/60 bg-card/40",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SettingsCardRow({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-sm font-medium text-txt-strong">{title}</div>
        {description ? (
          <div className="text-xs leading-relaxed text-muted">
            {description}
          </div>
        ) : null}
      </div>
      {action ? (
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          {action}
        </div>
      ) : null}
    </div>
  );
}

function ConnectorListRow({
  plugin,
  onOpen,
}: {
  plugin: PluginInfo;
  onOpen: () => void;
}) {
  const t = useAppSelector((s) => s.t);
  const Icon = useMemo(() => connectorIcon(plugin), [plugin]);
  const status = connectorStatusLabel(plugin, t);
  const label = t("connectors.configure", {
    defaultValue: "Configure",
  });

  return (
    <button
      type="button"
      data-connector={plugin.id}
      data-testid={`connector-row-${plugin.id}`}
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-hover/60"
    >
      <Icon className="h-[18px] w-[18px] shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-txt-strong">
          {plugin.name}
        </span>
        <span className={cn("block text-xs", statusToneClass(status.tone))}>
          {status.label}
        </span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted">
        {label}
        <ChevronRight className="h-4 w-4" aria-hidden />
      </span>
    </button>
  );
}

function ConnectorConfigurationSurface({ plugin }: { plugin: PluginInfo }) {
  const t = useAppSelector((s) => s.t);
  const elizaCloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const handlePluginConfigSave = useAppSelector(
    (s) => s.handlePluginConfigSave,
  );
  const pluginSaving = useAppSelector((s) => s.pluginSaving);
  const [pluginConfigs, setPluginConfigs] = useState<
    Record<string, Record<string, string>>
  >({});
  const [localSaving, setLocalSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  // Only offer setup modes that belong to the active Delegate/Bot lens.
  const channelMode = useConnectorChannelMode();
  const connectorMode = useConnectorMode(plugin.id, {
    elizaCloudConnected,
    channelMode,
  });
  const setupPluginId = connectorMode.setupPluginId;
  const setupPanel =
    setupPluginId && hasConnectorSetupPanel(setupPluginId) ? (
      <ConnectorSetupPanel
        pluginId={setupPluginId}
        modeId={connectorMode.selectedMode}
      />
    ) : null;
  const selectedMode = connectorMode.modes.find(
    (mode) => mode.id === connectorMode.selectedMode,
  );
  const configFormHint = getConnectorModeConfigFormHint(
    plugin.id,
    connectorMode.selectedMode,
  );
  const showPluginConfig = shouldRenderConnectorConfigForm({
    managementMode: selectedMode?.managementMode,
    hasParameters: plugin.parameters.length > 0,
    setupTargetsPlugin: (setupPluginId ?? plugin.id) === plugin.id,
  });
  const hiddenConfigKeys = useMemo(
    () => [
      ...getConnectorSurfaceOwnedConfigKeys(plugin),
      ...getConnectorModeHiddenConfigKeys(
        plugin.id,
        connectorMode.selectedMode,
      ),
    ],
    [connectorMode.selectedMode, plugin],
  );
  const pendingConfig = pluginConfigs[plugin.id] ?? {};
  const hasPendingConfig = Object.keys(pendingConfig).length > 0;
  const isSaving = localSaving || pluginSaving.has(plugin.id);

  // Dialog Save stages a field. The trailing action row commits the complete
  // credential bundle once so the runtime applies/restarts at most once.
  const handleParamChange = useCallback(
    (pluginId: string, paramKey: string, value: string) => {
      setPluginConfigs((prev) => ({
        ...prev,
        [pluginId]: { ...prev[pluginId], [paramKey]: value },
      }));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (saveInFlightRef.current || Object.keys(pendingConfig).length === 0) {
      return;
    }
    saveInFlightRef.current = true;
    const submitted = { ...pendingConfig };
    setLocalSaving(true);
    try {
      const saved = await handlePluginConfigSave(plugin.id, submitted);
      if (!saved) return;
      // Do not clear a value edited again while this request was in flight.
      setPluginConfigs((prev) => {
        const current = prev[plugin.id];
        if (!current) return prev;
        const remaining = Object.fromEntries(
          Object.entries(current).filter(
            ([key, value]) => submitted[key] !== value,
          ),
        );
        const next = { ...prev };
        if (Object.keys(remaining).length === 0) delete next[plugin.id];
        else next[plugin.id] = remaining;
        return next;
      });
    } finally {
      saveInFlightRef.current = false;
      setLocalSaving(false);
    }
  }, [handlePluginConfigSave, pendingConfig, plugin.id]);

  const handleCancel = useCallback(() => {
    setPluginConfigs((prev) => {
      if (!prev[plugin.id]) return prev;
      const next = { ...prev };
      delete next[plugin.id];
      return next;
    });
  }, [plugin.id]);

  return (
    <div className="flex flex-col gap-3 [&>*]:mt-0">
      {connectorMode.modes.length > 1 ? (
        <div className="px-1">
          <ConnectorModeSelector
            connectorId={plugin.id}
            selectedMode={connectorMode.selectedMode}
            onModeChange={connectorMode.setSelectedMode}
            elizaCloudConnected={elizaCloudConnected}
            channelMode={channelMode}
          />
        </div>
      ) : null}

      {showPluginConfig ? (
        <>
          <PluginConfigForm
            plugin={plugin}
            pluginConfigs={pluginConfigs}
            onParamChange={handleParamChange}
            layout="rows"
            hiddenKeys={hiddenConfigKeys}
          />
          {setupPanel}
          {configFormHint ? (
            <p className="px-1 text-xs-tight text-muted">
              {configFormHint.key
                ? t(configFormHint.key, {
                    defaultValue: configFormHint.fallback,
                  })
                : configFormHint.fallback}
            </p>
          ) : null}
          {hasPendingConfig || isSaving ? (
            <div className="flex items-center justify-end gap-2 border-t border-border/50 pt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                disabled={isSaving}
              >
                {t("common.cancel", { defaultValue: "Cancel" })}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => void handleSave()}
                disabled={!hasPendingConfig || isSaving}
              >
                {isSaving
                  ? t("common.saving", { defaultValue: "Saving…" })
                  : t("pluginsview.SaveSettings", {
                      defaultValue: "Save changes",
                    })}
              </Button>
            </div>
          ) : null}
        </>
      ) : setupPanel ? (
        setupPanel
      ) : (
        <p className="px-1 text-xs-tight text-muted">
          {t("settings.sections.connectors.ownSetupSurface", {
            defaultValue: "{{name}} uses its own setup surface.",
            name: plugin.name,
          })}
        </p>
      )}
    </div>
  );
}

function ConnectorEnableSwitch({
  plugin,
  busy,
  onToggle,
}: {
  plugin: PluginInfo;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const t = useAppSelector((s) => s.t);
  const label = plugin.enabled
    ? t("settings.sections.connectors.disable", {
        defaultValue: "Disable {{name}}",
        name: plugin.name,
      })
    : t("settings.sections.connectors.enable", {
        defaultValue: "Enable {{name}}",
        name: plugin.name,
      });
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-enable`,
    role: "toggle",
    label,
    group: "connectors",
    status: plugin.enabled ? "on" : "off",
    getValue: () => plugin.enabled,
    onActivate: busy ? undefined : () => onToggle(!plugin.enabled),
  });
  return (
    <Switch
      ref={ref}
      checked={plugin.enabled}
      disabled={busy}
      onCheckedChange={(checked) => onToggle(checked)}
      aria-label={label}
      {...agentProps}
    />
  );
}

function ConnectorDetailPage({
  plugin,
  onBack,
}: {
  plugin: PluginInfo;
  onBack: () => void;
}) {
  const t = useAppSelector((s) => s.t);
  const handlePluginToggle = useAppSelector((s) => s.handlePluginToggle);
  const [busy, setBusy] = useState(false);
  const Icon = useMemo(() => connectorIcon(plugin), [plugin]);
  const status = connectorStatusLabel(plugin, t);
  const links = useMemo(() => getPluginResourceLinks(plugin), [plugin]);
  const tagline =
    plugin.description?.trim() ||
    t("connectors.detail.taglineFallback", {
      defaultValue: "Connect {{name}} so the agent can use this channel.",
      name: plugin.name,
    });

  const onToggle = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        await handlePluginToggle(plugin.id, enabled);
      } finally {
        setBusy(false);
      }
    },
    [handlePluginToggle, plugin.id],
  );

  return (
    <div className="flex flex-col gap-6" data-testid="connector-detail">
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onBack}
          className="hidden self-start text-xs font-medium text-muted hover:text-txt md:inline-flex"
          data-testid="connector-detail-back"
        >
          {t("connectors.detail.back", { defaultValue: "← Connectors" })}
        </button>
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border/50 bg-bg-accent/70">
            <Icon className="h-5 w-5 text-txt" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-txt-strong">
              {plugin.name}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{tagline}</p>
            <p
              className={cn(
                "mt-1 text-xs font-medium",
                statusToneClass(status.tone),
              )}
            >
              {status.label}
            </p>
          </div>
        </div>
      </div>

      {/* Load/enable is the global gate — always first when present. */}
      <SettingsCard>
        <SettingsCardRow
          title={t("settings.sections.connectors.enablePlugin", {
            defaultValue: "Enable {{name}} connector",
            name: plugin.name,
          })}
          description={t("settings.sections.connectors.enableHelp", {
            defaultValue:
              "Load the plugin so the agent can use this channel when configured.",
          })}
          action={
            <ConnectorEnableSwitch
              plugin={plugin}
              busy={busy}
              onToggle={(checked) => {
                void onToggle(checked);
              }}
            />
          }
        />
      </SettingsCard>

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted">
          {t("connectors.detail.connection", { defaultValue: "Connection" })}
        </h3>
        {/* No outer SettingsCard here — row layout / setup panels bring their
            own chrome. Nesting cards left a hollow gap above the old save bar. */}
        <ConnectorConfigurationSurface plugin={plugin} />
      </section>

      {links.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted">
            {t("connectors.detail.support", { defaultValue: "Support" })}
          </h3>
          <SettingsCard>
            {links.map((link, index) => (
              <SettingsCardRow
                key={link.key}
                className={index > 0 ? "border-t border-border/50" : undefined}
                title={pluginResourceLinkLabel(t, link.key)}
                description={
                  link.key === "guide"
                    ? t("connectors.detail.docsHelp", {
                        defaultValue: "Learn how {{name}} works with Eliza.",
                        name: plugin.name,
                      })
                    : undefined
                }
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-sm px-3 text-xs-tight font-semibold"
                    asChild
                  >
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t("connectors.detail.openLink", {
                        defaultValue: "Open",
                      })}{" "}
                      ↗
                    </a>
                  </Button>
                }
              />
            ))}
          </SettingsCard>
        </section>
      ) : null}
    </div>
  );
}

function ConnectorsIndex({
  connectors,
  hiddenConnectors,
  channelMode,
  onOpen,
}: {
  connectors: PluginInfo[];
  hiddenConnectors: PluginInfo[];
  channelMode: ConnectorChannelMode;
  onOpen: (id: string) => void;
}) {
  const t = useAppSelector((s) => s.t);
  const channelModeCopy = connectorChannelModeCopy(t);
  const otherChannelMode: ConnectorChannelMode =
    channelMode === "delegate" ? "bot" : "delegate";

  const grouped = useMemo(() => {
    const buckets = new Map<string, PluginInfo[]>();
    for (const plugin of connectors) {
      const groupId = getConnectorUiGroupId(plugin.id);
      const list = buckets.get(groupId) ?? [];
      list.push(plugin);
      buckets.set(groupId, list);
    }
    return CONNECTOR_UI_GROUPS.map((meta) => ({
      meta,
      items: (buckets.get(meta.id) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    })).filter((entry) => entry.items.length > 0);
  }, [connectors]);

  return (
    <div className="flex flex-col gap-5" data-testid="connectors-index">
      <div className="flex flex-col items-start gap-1">
        <ConnectorChannelModeSwitch />
        <p className="text-xs-tight text-muted">
          {channelModeCopy[channelMode].description}
        </p>
      </div>

      {grouped.map(({ meta, items }) => (
        <section key={meta.id} className="space-y-2">
          <div>
            <h3 className="text-sm font-medium text-txt-strong">
              {t(`connectors.groups.${meta.id}.label`, {
                defaultValue: meta.label,
              })}
            </h3>
            <p className="text-xs text-muted">
              {t(`connectors.groups.${meta.id}.description`, {
                defaultValue: meta.description,
              })}
            </p>
          </div>
          <SettingsCard>
            {items.map((plugin, index) => (
              <div
                key={plugin.id}
                className={index > 0 ? "border-t border-border/50" : undefined}
              >
                <ConnectorListRow
                  plugin={plugin}
                  onOpen={() => onOpen(plugin.id)}
                />
              </div>
            ))}
          </SettingsCard>
        </section>
      ))}

      {hiddenConnectors.length > 0 ? (
        <p className="text-xs-tight text-muted">
          {t("settings.sections.connectors.channelModeHidden", {
            defaultValue: "Available in {{mode}} mode: {{names}}.",
            mode: channelModeCopy[otherChannelMode].label,
            names: hiddenConnectors.map((p) => p.name).join(", "),
          })}{" "}
          <button
            type="button"
            className="font-medium text-accent underline-offset-2 hover:underline"
            onClick={() => setConnectorChannelMode(otherChannelMode)}
          >
            {t("settings.sections.connectors.channelModeSwitch", {
              defaultValue: "Switch to {{mode}}",
              mode: channelModeCopy[otherChannelMode].label,
            })}
          </button>
        </p>
      ) : null}
    </div>
  );
}

export function ConnectorsSection() {
  const plugins = useAppSelector((s) => s.plugins);
  const t = useAppSelector((s) => s.t);
  const channelMode = useConnectorChannelMode();
  const route = useSettingsRoute();
  const detailId =
    route.kind === "connector-detail"
      ? normalizeConnectorRouteId(route.connectorId)
      : null;

  const allConnectorPlugins = useMemo(
    () =>
      plugins.filter(
        (p) =>
          p.category === "connector" &&
          !ALWAYS_ON_PLUGIN_IDS.has(p.id) &&
          p.visible !== false,
      ),
    [plugins],
  );

  const connectorPlugins = useMemo(
    () =>
      allConnectorPlugins.filter((p) =>
        connectorSupportsChannelMode(p.id, channelMode),
      ),
    [allConnectorPlugins, channelMode],
  );

  const hiddenConnectors = useMemo(
    () =>
      allConnectorPlugins.filter(
        (p) => !connectorSupportsChannelMode(p.id, channelMode),
      ),
    [allConnectorPlugins, channelMode],
  );

  const detailPlugin = useMemo(() => {
    if (!detailId) return null;
    return (
      allConnectorPlugins.find(
        (p) => normalizeConnectorRouteId(p.id) === detailId,
      ) ?? null
    );
  }, [allConnectorPlugins, detailId]);

  const openDetail = useCallback((connectorId: string) => {
    openConnectorDetailHash(connectorId);
    // pushState does not emit popstate/hashchange — nudge subscribers.
    window.dispatchEvent(new Event("popstate"));
  }, []);

  const focusDetail = useCallback((connectorId: string) => {
    replaceConnectorDetailHash(connectorId);
    window.dispatchEvent(new Event("popstate"));
  }, []);

  const backToIndex = useCallback(() => {
    openConnectorsIndexHash();
    window.dispatchEvent(new Event("popstate"));
  }, []);

  // Focus / deep-link events navigate to detail (no accordion open).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleFocusConnector = (event: Event) => {
      const detail = (event as CustomEvent<FocusConnectorEventDetail>).detail;
      if (!detail?.connectorId) return;
      focusDetail(detail.connectorId);
      clearPendingFocusConnector(detail.connectorId);
    };
    document.addEventListener(FOCUS_CONNECTOR_EVENT, handleFocusConnector);
    const pending = readPendingFocusConnector();
    if (pending) {
      focusDetail(pending);
      clearPendingFocusConnector(pending);
    }
    return () =>
      document.removeEventListener(FOCUS_CONNECTOR_EVENT, handleFocusConnector);
  }, [focusDetail]);

  if (allConnectorPlugins.length === 0) {
    return (
      <p className="text-sm text-muted">
        {t("pluginsview.NoConnectorsAvailable", {
          defaultValue: "No connectors available.",
        })}
      </p>
    );
  }

  if (detailId) {
    if (!detailPlugin) {
      return (
        <div className="space-y-3" data-testid="connector-not-found">
          <p className="text-sm text-muted">
            {t("connectors.detail.notFound", {
              defaultValue: 'Connector "{{id}}" was not found.',
              id: detailId,
            })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={backToIndex}
            className="h-8 rounded-sm px-3 text-xs-tight font-semibold"
          >
            {t("connectors.detail.backToList", {
              defaultValue: "Back to Connectors",
            })}
          </Button>
        </div>
      );
    }
    return <ConnectorDetailPage plugin={detailPlugin} onBack={backToIndex} />;
  }

  return (
    <ConnectorsIndex
      connectors={connectorPlugins}
      hiddenConnectors={hiddenConnectors}
      channelMode={channelMode}
      onOpen={openDetail}
    />
  );
}
