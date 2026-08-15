/**
 * Mode selector for a connector's setup surface: renders the connector's
 * declared setup modes (from `ConnectorModeSelector.helpers`, ultimately the
 * connector-mode registry) as a button group. Renders nothing when the
 * connector has one mode or fewer.
 */

import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import { getConnectorModes } from "./ConnectorModeSelector.helpers";
import type { ConnectorChannelMode } from "./connector-channel-mode";

export type { ConnectorMode } from "./ConnectorModeSelector.helpers";

export function ConnectorModeSelector({
  connectorId,
  selectedMode,
  onModeChange,
  elizaCloudConnected,
  cloudProvisioned,
  channelMode,
}: {
  connectorId: string;
  selectedMode: string;
  onModeChange: (modeId: string) => void;
  elizaCloudConnected?: boolean;
  /** Whether the agent host is a managed Eliza Cloud container. */
  cloudProvisioned?: boolean;
  /** Global channel-mode lens; filters out modes classified into the other lens. */
  channelMode?: ConnectorChannelMode;
}) {
  const t = useAppSelector((s) => s.t);
  const modes = getConnectorModes(connectorId, {
    elizaCloudConnected,
    cloudProvisioned,
    channelMode,
  });

  if (modes.length <= 1) return null;

  return (
    <div className="mb-4">
      <div className="mb-2 text-xs font-semibold text-muted">
        {t("pluginsview.ConnectionMode", {
          defaultValue: "Connection mode",
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {modes.map((mode) => (
          <Button
            key={mode.id}
            variant="ghost"
            data-testid={`connector-mode-${connectorId}-${mode.id}`}
            onClick={() => onModeChange(mode.id)}
            className={`h-auto rounded-sm border px-3 py-1.5 text-xs-tight font-medium transition-all ${
              selectedMode === mode.id
                ? "border-accent bg-accent/10 text-accent"
                : "border-border/40 bg-card/40 text-muted hover:border-accent/40 hover:text-txt"
            }`}
            title={
              mode.descriptionKey
                ? t(mode.descriptionKey, { defaultValue: mode.description })
                : mode.description
            }
          >
            {mode.labelKey
              ? t(mode.labelKey, { defaultValue: mode.label })
              : mode.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
