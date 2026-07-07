/**
 * Notifications settings section — minimal, tasteful web-push toggle for the
 * installed iOS PWA (16.4+). Follows the existing SettingsGroup/SettingsRow
 * pattern; the whole behavior lives in `useWebPush`. This is intentionally a
 * single toggle + status copy, not new elaborate UX: it lets the user turn on
 * push and reflects the coarse state, degrading gracefully everywhere push
 * isn't available (unsupported browser, non-standalone, unconfigured VAPID).
 */

import { BellRing } from "lucide-react";
import { useCallback } from "react";
import { useAgentElement } from "../../agent-surface";
import { useWebPush } from "../../state/notifications/useWebPush";
import { Switch } from "../ui/switch";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

/** Human copy for each coarse state. */
function describeState(state: ReturnType<typeof useWebPush>["state"]): {
  label: string;
  description: string;
  canToggle: boolean;
  on: boolean;
} {
  switch (state) {
    case "subscribed":
      return {
        label: "Push notifications",
        description:
          "On. You'll be notified of new messages when the app is closed.",
        canToggle: true,
        on: true,
      };
    case "default":
      return {
        label: "Push notifications",
        description: "Get notified of new messages when the app is closed.",
        canToggle: true,
        on: false,
      };
    case "denied":
      return {
        label: "Push notifications",
        description:
          "Blocked. Enable notifications for this app in your device Settings, then reopen.",
        canToggle: false,
        on: false,
      };
    case "unconfigured":
      return {
        label: "Push notifications",
        description: "Not available on this server yet.",
        canToggle: false,
        on: false,
      };
    default:
      return {
        label: "Push notifications",
        description:
          "Only available in the installed app (Add to Home Screen) on supported devices.",
        canToggle: false,
        on: false,
      };
  }
}

export function WebPushSettingsSection() {
  const { state, busy, error, ready, subscribe, unsubscribe } = useWebPush();
  const view = describeState(state);

  const onToggle = useCallback(
    (checked: boolean) => {
      // Called from the Switch's click — inside the user gesture (iOS requires
      // the permission prompt + subscribe to run in the gesture task).
      if (checked) void subscribe();
      else void unsubscribe();
    },
    [subscribe, unsubscribe],
  );

  // Agent-addressable so "turn on notifications" reaches the toggle from chat +
  // voice, like every other settings control.
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "notifications-push-toggle",
    role: "toggle",
    label: view.label,
    group: "settings",
    status: view.canToggle ? (view.on ? "on" : "off") : "unavailable",
    onActivate: () => {
      if (view.canToggle && !busy && ready) onToggle(!view.on);
    },
  });

  return (
    <SettingsStack>
      <SettingsGroup title="Notifications">
        <SettingsRow
          icon={BellRing}
          label={view.label}
          description={error ?? view.description}
          control={
            <Switch
              ref={ref}
              checked={view.on}
              disabled={!view.canToggle || busy || !ready}
              onCheckedChange={onToggle}
              aria-label="Toggle push notifications"
              {...agentProps}
            />
          }
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
