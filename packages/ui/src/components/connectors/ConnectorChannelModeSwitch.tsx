/**
 * Global Delegate / Bot segmented switch for the Connectors surface. Rendered
 * left-aligned at the top of Settings → Connectors (below the page header
 * divider); writes the shared channel-mode store (`connector-channel-mode.ts`)
 * that the section body reads to filter connectors and their setup modes.
 */

import { useAppSelector } from "../../state";
import { SegmentedControl } from "../ui/segmented-control";
import {
  type ConnectorChannelMode,
  setConnectorChannelMode,
  useConnectorChannelMode,
} from "./connector-channel-mode";

/** Short human labels + tooltips for the two lenses, i18n-keyed. */
export function connectorChannelModeCopy(
  t: (key: string, options?: Record<string, unknown>) => string,
): Record<ConnectorChannelMode, { label: string; description: string }> {
  return {
    delegate: {
      label: t("connectors.channelMode.delegate.label", {
        defaultValue: "Delegate",
      }),
      description: t("connectors.channelMode.delegate.description", {
        defaultValue:
          "Your accounts — the agent reads incoming messages and replies as you.",
      }),
    },
    bot: {
      label: t("connectors.channelMode.bot.label", { defaultValue: "Bot" }),
      description: t("connectors.channelMode.bot.description", {
        defaultValue:
          "The agent's own bot — connect it to a platform and chat with it from there.",
      }),
    },
  };
}

export function ConnectorChannelModeSwitch() {
  const t = useAppSelector((s) => s.t);
  const channelMode = useConnectorChannelMode();
  const copy = connectorChannelModeCopy(t);

  return (
    <SegmentedControl<ConnectorChannelMode>
      aria-label={t("connectors.channelMode.switchLabel", {
        defaultValue: "Connector mode",
      })}
      value={channelMode}
      onValueChange={setConnectorChannelMode}
      // Contained chip: outer border + wash so the lens reads as a control
      // (not bare text tabs). Active segment uses the app's orange
      // selected-chip idiom — never blue; hover darkens the orange wash.
      className="max-w-full shrink-0 self-start rounded-md border border-border/60 bg-card/50 p-0.5"
      buttonClassName="px-3 py-1.5"
      activeButtonClassName="border border-accent bg-accent/10 text-accent hover:bg-accent/15 hover:text-accent"
      inactiveButtonClassName="border border-transparent text-muted hover:bg-bg-hover hover:text-txt"
      items={(["delegate", "bot"] as const).map((mode) => ({
        value: mode,
        label: <span title={copy[mode].description}>{copy[mode].label}</span>,
        testId: `connector-channel-mode-${mode}`,
      }))}
    />
  );
}
