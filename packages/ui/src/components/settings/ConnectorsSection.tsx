/**
 * Settings → Connectors section.
 *
 * The connector id→panel dispatch is hardcoded — AGENTS.md commandment 5 (zero
 * polymorphism for runtime type branching) explicitly allows this for
 * adapter/target registries.
 */

import { type LucideIcon, type LucideProps, Puzzle, Save } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import type { PluginInfo } from "../../api";
import {
  clearPendingFocusConnector,
  FOCUS_CONNECTOR_EVENT,
  type FocusConnectorEventDetail,
  readPendingFocusConnector,
} from "../../events";
import { useAppSelector } from "../../state";
import { ConnectorModeSelector } from "../connectors/ConnectorModeSelector";
import type { ConnectorMode } from "../connectors/ConnectorModeSelector.helpers";
import { useConnectorMode } from "../connectors/ConnectorModeSelector.hooks";
import { ConnectorSetupPanel } from "../connectors/ConnectorSetupPanel";
import { hasConnectorSetupPanel } from "../connectors/ConnectorSetupPanel.helpers";
import { getBrandIcon } from "../conversations/brand-icons";
import { PluginConfigForm } from "../pages/PluginConfigForm";
import {
  ALWAYS_ON_PLUGIN_IDS,
  iconImageSource,
  resolveIcon,
} from "../pages/plugin-list-utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

type ConnectorStatusTone = "ok" | "warn" | "off";

/**
 * Whether Settings → Connectors should render the generic plugin-config (env
 * credential) form for the selected connector mode.
 *
 * The form is shown for a `local-config` mode whose setup target is the
 * plugin itself and that actually declares parameters — and for connectors
 * with NO declared mode list at all (farcaster, bluesky, matrix, nostr, …):
 * those have no dedicated panel to protect, so a declared-parameters plugin
 * gets the credential form instead of a dead-end. Every other mode kind —
 * `local-setup` (iMessage Full-Disk-Access status, Signal/WhatsApp QR pairing,
 * Discord/Telegram desktop panels), `plugin-managed` account lists, and
 * `cloud-managed` gateways — keeps its dedicated {@link ConnectorSetupPanel}
 * surface. Gating on the mode KIND rather than the incidental
 * "this plugin declares parameters" is what keeps those dedicated panels
 * reachable instead of being overwritten by a raw env form.
 */
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

function statusTone(plugin: PluginInfo): ConnectorStatusTone {
  if (!plugin.enabled) return "off";
  if (plugin.validationErrors.length > 0) return "warn";
  if (!plugin.configured) return "warn";
  return "ok";
}

function statusDotClass(tone: ConnectorStatusTone): string {
  switch (tone) {
    case "ok":
      return "bg-ok";
    case "warn":
      return "bg-warn";
    case "off":
      return "bg-muted/60";
  }
}

/**
 * A {@link LucideIcon}-compatible medallion icon for a connector so it can be
 * passed to {@link SettingsRow}'s `icon` slot — brand SVG, plugin image, or a
 * Puzzle fallback.
 */
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

function ConnectorBody({ plugin }: { plugin: PluginInfo }) {
  const t = useAppSelector((s) => s.t);
  const elizaCloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const handlePluginConfigSave = useAppSelector(
    (s) => s.handlePluginConfigSave,
  );
  const pluginSaving = useAppSelector((s) => s.pluginSaving);
  const pluginSaveSuccess = useAppSelector((s) => s.pluginSaveSuccess);
  const [pluginConfigs, setPluginConfigs] = useState<
    Record<string, Record<string, string>>
  >({});
  const connectorMode = useConnectorMode(plugin.id, { elizaCloudConnected });
  const setupPluginId = connectorMode.setupPluginId;
  const setupPanel =
    setupPluginId && hasConnectorSetupPanel(setupPluginId) ? (
      <ConnectorSetupPanel pluginId={setupPluginId} />
    ) : null;
  const selectedMode = connectorMode.modes.find(
    (mode) => mode.id === connectorMode.selectedMode,
  );
  const showPluginConfig = shouldRenderConnectorConfigForm({
    managementMode: selectedMode?.managementMode,
    hasParameters: plugin.parameters.length > 0,
    // Mirror the canonical /connectors fallback: a connector with no declared
    // mode list has no companion setup plugin, so its own credential form is
    // the setup surface (previously a dead-end "uses its own setup surface").
    setupTargetsPlugin: (setupPluginId ?? plugin.id) === plugin.id,
  });
  const pendingConfig = pluginConfigs[plugin.id] ?? {};
  const hasPendingConfig = Object.keys(pendingConfig).length > 0;
  const isSaving = pluginSaving.has(plugin.id);
  const didSave = pluginSaveSuccess.has(plugin.id);

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
    // Only clear the draft when the save persisted — sensitive params never
    // echo back from the server, so wiping on failure loses the pasted token.
    const saved = await handlePluginConfigSave(plugin.id, pendingConfig);
    if (!saved) return;
    setPluginConfigs((prev) => {
      const next = { ...prev };
      delete next[plugin.id];
      return next;
    });
  }, [handlePluginConfigSave, pendingConfig, plugin.id]);

  return (
    <div className="space-y-4">
      {connectorMode.modes.length > 1 ? (
        <ConnectorModeSelector
          connectorId={plugin.id}
          selectedMode={connectorMode.selectedMode}
          onModeChange={connectorMode.setSelectedMode}
          elizaCloudConnected={elizaCloudConnected}
        />
      ) : null}

      {showPluginConfig ? (
        <div className="space-y-3">
          <PluginConfigForm
            plugin={plugin}
            pluginConfigs={pluginConfigs}
            onParamChange={handleParamChange}
          />
          {/* Co-render the live setup/status panel (e.g. Telegram bot-token
              validation + identity) directly under the env-config form, matching
              the canonical /connectors surface (plugin-view-connectors.tsx) where
              the panel sits between the form and the save action. Without this, a
              `local-config` connector that also has a setup panel (telegram bot
              mode) showed the raw-token form only. `setupPanel` is already
              null-gated to `setupPluginId`, so it is a no-op otherwise. */}
          {setupPanel}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              size="sm"
              className="h-8 gap-1.5 rounded-sm px-4 text-xs-tight font-semibold"
              onClick={() => {
                void handleSave();
              }}
              disabled={!hasPendingConfig || isSaving}
            >
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
              {isSaving
                ? t("common.saving", { defaultValue: "Saving..." })
                : didSave
                  ? t("pluginsview.Saved", { defaultValue: "Saved" })
                  : t("pluginsview.SaveSettings", {
                      defaultValue: "Save settings",
                    })}
            </Button>
            {plugin.id === "discord" ? (
              <span className="text-xs-tight text-muted">
                {t("settings.sections.connectors.discordAppIdHint", {
                  defaultValue:
                    "Application ID is optional; it is auto-resolved from the bot token when possible.",
                })}
              </span>
            ) : null}
          </div>
        </div>
      ) : setupPanel ? (
        setupPanel
      ) : (
        <div className="text-xs-tight text-muted">
          {t("settings.sections.connectors.ownSetupSurface", {
            defaultValue: "{{name}} uses its own setup surface.",
            name: plugin.name,
          })}
        </div>
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
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onCheckedChange={(checked) => onToggle(checked)}
      aria-label={label}
      {...agentProps}
    />
  );
}

function ConnectorRow({
  plugin,
  busy,
  onToggle,
}: {
  plugin: PluginInfo;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const tone = statusTone(plugin);
  const icon = useMemo(() => connectorIcon(plugin), [plugin]);

  return (
    <details className="group" data-connector={plugin.id}>
      <summary className="cursor-pointer select-none list-none">
        <SettingsRow
          icon={icon}
          label={
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{plugin.name}</span>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(tone)}`}
                aria-hidden="true"
              />
            </span>
          }
          control={
            <ConnectorEnableSwitch
              plugin={plugin}
              busy={busy}
              onToggle={onToggle}
            />
          }
        />
      </summary>
      <div className="pb-3 pl-[30px]">
        <ConnectorBody plugin={plugin} />
      </div>
    </details>
  );
}

export function ConnectorsSection() {
  const plugins = useAppSelector((s) => s.plugins);
  const handlePluginToggle = useAppSelector((s) => s.handlePluginToggle);
  const t = useAppSelector((s) => s.t);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [togglingPlugins, setTogglingPlugins] = useState<Set<string>>(
    new Set(),
  );

  const connectorPlugins = plugins.filter(
    (p) =>
      p.category === "connector" &&
      !ALWAYS_ON_PLUGIN_IDS.has(p.id) &&
      p.visible !== false,
  );

  const focusConnector = useCallback((connectorId: string) => {
    const escapedId = connectorId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const focus = () => {
      const row = containerRef.current?.querySelector(
        `[data-connector="${escapedId}"]`,
      );
      if (!(row instanceof HTMLDetailsElement)) return false;
      row.open = true;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      const summary = row.querySelector("summary");
      if (summary instanceof HTMLElement)
        summary.focus({ preventScroll: true });
      clearPendingFocusConnector(connectorId);
      return true;
    };
    if (focus()) return;
    window.setTimeout(() => {
      focus();
    }, 80);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleFocusConnector = (event: Event) => {
      const detail = (event as CustomEvent<FocusConnectorEventDetail>).detail;
      if (!detail?.connectorId) return;
      focusConnector(detail.connectorId);
    };
    document.addEventListener(FOCUS_CONNECTOR_EVENT, handleFocusConnector);
    const pending = readPendingFocusConnector();
    if (pending) focusConnector(pending);
    return () =>
      document.removeEventListener(FOCUS_CONNECTOR_EVENT, handleFocusConnector);
  }, [focusConnector]);

  const handleToggle = useCallback(
    async (pluginId: string, enabled: boolean) => {
      setTogglingPlugins((prev) => new Set(prev).add(pluginId));
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

  if (connectorPlugins.length === 0) {
    return (
      <p className="text-sm text-muted">
        {t("pluginsview.NoConnectorsAvailable", {
          defaultValue: "No connectors available.",
        })}
      </p>
    );
  }

  return (
    <SettingsStack>
      <SettingsGroup
        bare
        title={t("settings.sections.connectors.groupTitle", {
          defaultValue: "Connectors",
        })}
      >
        <div ref={containerRef} className="flex flex-col">
          {connectorPlugins.map((plugin) => {
            const isBusy = togglingPlugins.has(plugin.id);
            return (
              <ConnectorRow
                key={plugin.id}
                plugin={plugin}
                busy={isBusy}
                onToggle={(checked) => {
                  void handleToggle(plugin.id, checked);
                }}
              />
            );
          })}
        </div>
      </SettingsGroup>
    </SettingsStack>
  );
}
