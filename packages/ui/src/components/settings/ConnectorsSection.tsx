/**
 * Settings → Connectors section.
 *
 * Renders one inline `<details>` row per active connector plugin. The summary
 * carries the brand icon + name + enable/disable Switch + status dot; the
 * expanded body dispatches to the existing per-connector setup panel by
 * plugin id.
 *
 * The id→panel dispatch is hardcoded — AGENTS.md commandment 5 (zero
 * polymorphism for runtime type branching) explicitly allows this for
 * adapter/target registries. There are a small, known set of connectors,
 * each with its own bespoke setup surface.
 */

import { Switch } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
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
      return "bg-success";
    case "warn":
      return "bg-warn";
    case "off":
      return "bg-muted/60";
  }
}

function ConnectorIcon({ plugin }: { plugin: PluginInfo }) {
  const Brand = getBrandIcon(plugin.id);
  if (Brand) return <Brand className="h-4 w-4" />;
  const icon = resolveIcon(plugin);
  if (!icon) return <span className="text-sm">🧩</span>;
  if (typeof icon === "string") {
    const src = iconImageSource(icon);
    return src ? (
      <img
        src={src}
        alt=""
        className="h-4 w-4 shrink-0 rounded-[var(--radius-sm)] object-contain"
      />
    ) : (
      <span className="text-sm">{icon}</span>
    );
  }
  const IconComponent = icon;
  return <IconComponent className="h-4 w-4" />;
}

function ConnectorBody({ plugin }: { plugin: PluginInfo }) {
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
        <p className="text-xs-tight text-muted">
          No inline setup available for {plugin.name}. Toggle the connector to
          enable it; further configuration (if any) lives in the plugin's own
          surface.
        </p>
      );
  }
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

  return (
    <details
      className="group rounded-xl border border-border/60 bg-card/45 transition-colors open:bg-card/65"
      data-connector={plugin.id}
    >
      <summary className="flex cursor-pointer select-none list-none items-center gap-3 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-card/60 text-txt">
          <ConnectorIcon plugin={plugin} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-semibold leading-5 text-txt">
            {plugin.name}
          </span>
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(tone)}`}
            aria-hidden="true"
          />
        </span>
        <Switch
          checked={plugin.enabled}
          disabled={busy}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
        />
      </summary>
      <div className="border-t border-border/40 px-3 py-3">
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
    <div ref={containerRef} className="space-y-2">
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
  );
}
