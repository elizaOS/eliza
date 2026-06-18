/**
 * Settings → Connectors section.
 *
 * The connector id→panel dispatch is hardcoded — AGENTS.md commandment 5 (zero
 * polymorphism for runtime type branching) explicitly allows this for
 * adapter/target registries.
 */

import { type LucideIcon, type LucideProps, Puzzle } from "lucide-react";
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
import { useApp } from "../../state";
import { BlueBubblesStatusPanel } from "../connectors/BlueBubblesStatusPanel";
import { DiscordLocalConnectorPanel } from "../connectors/DiscordLocalConnectorPanel";
import { IMessageStatusPanel } from "../connectors/IMessageStatusPanel";
import { SignalQrOverlay } from "../connectors/SignalQrOverlay";
import { TelegramAccountConnectorPanel } from "../connectors/TelegramAccountConnectorPanel";
import { WhatsAppQrOverlay } from "../connectors/WhatsAppQrOverlay";
import { getBrandIcon } from "../conversations/brand-icons";
import {
  ALWAYS_ON_PLUGIN_IDS,
  iconImageSource,
  resolveIcon,
} from "../pages/plugin-list-utils";
import { Switch } from "../ui/switch";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

type ConnectorStatusTone = "ok" | "warn" | "off";

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
  return forwardRef<SVGSVGElement, LucideProps>(
    function ConnectorMedallionIcon({ className }) {
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
      if (IconComponent) return <IconComponent className={className} />;
      return <Puzzle className={className} aria-hidden />;
    },
  );
}

function ConnectorBody({ plugin }: { plugin: PluginInfo }) {
  const { t } = useApp();
  switch (plugin.id) {
    case "telegram":
      return <TelegramAccountConnectorPanel />;
    case "discord":
      return <DiscordLocalConnectorPanel />;
    case "imessage":
      return <IMessageStatusPanel />;
    case "bluebubbles":
      return <BlueBubblesStatusPanel />;
    case "signal":
      return <SignalQrOverlay />;
    case "whatsapp":
      return <WhatsAppQrOverlay />;
    default:
      return (
        <div className="text-xs-tight text-muted">
          {t("settings.sections.connectors.ownSetupSurface", {
            defaultValue: "{{name}} uses its own setup surface.",
            name: plugin.name,
          })}
        </div>
      );
  }
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
  const { t } = useApp();
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
    <details
      className="group overflow-hidden rounded-lg border border-border bg-card transition-colors hover:bg-surface open:bg-card open:hover:bg-card"
      data-connector={plugin.id}
    >
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
      <div className="border-t border-border/60 px-4 py-3">
        <ConnectorBody plugin={plugin} />
      </div>
    </details>
  );
}

export function ConnectorsSection() {
  const { plugins, handlePluginToggle, t } = useApp();
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
        <div ref={containerRef} className="flex flex-col gap-2">
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
