/**
 * Notifications section for the cloud-only settings panel. Combines the shared
 * web-push toggle (reusing `useWebPush`) with desktop notification behavior
 * switches and a test-notification action. The behavior toggles are local state
 * for now — the desktop RPC that persists them still needs to be wired, so they
 * only reflect in-session preferences until that lands.
 */

import { Bell, Circle, Volume2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useWebPush } from "../../../../state/notifications/useWebPush";
import {
  NuphyActionButton,
  NuphyRow,
  NuphySwitchRow,
  SettingsGroup,
  SettingsStack,
} from "../nuphy-settings-primitives";

/** Coarse push-permission copy, mirroring WebPushSettingsSection. */
function describePushState(state: ReturnType<typeof useWebPush>["state"]): {
  label: string;
  description: string;
  canToggle: boolean;
  on: boolean;
} {
  switch (state) {
    case "subscribed":
      return {
        label: "Granted",
        description:
          "On. You'll be notified of new messages when the app is closed.",
        canToggle: true,
        on: true,
      };
    case "default":
      return {
        label: "Not granted",
        description: "Get notified of new messages when the app is closed.",
        canToggle: true,
        on: false,
      };
    case "denied":
      return {
        label: "Blocked",
        description:
          "Blocked. Enable notifications for this app in your device Settings, then reopen.",
        canToggle: false,
        on: false,
      };
    case "unconfigured":
      return {
        label: "Unavailable",
        description: "Not available on this server yet.",
        canToggle: false,
        on: false,
      };
    default:
      return {
        label: "Unavailable",
        description:
          "Only available in the installed app (Add to Home Screen) on supported devices.",
        canToggle: false,
        on: false,
      };
  }
}

export function NotificationsSection() {
  const { state, busy, error, ready, subscribe, unsubscribe } = useWebPush();
  const push = describePushState(state);

  const onPushToggle = useCallback(
    (checked: boolean) => {
      // Must run inside the user gesture — iOS requires requestPermission +
      // subscribe in the same task.
      if (checked) void subscribe();
      else void unsubscribe();
    },
    [subscribe, unsubscribe],
  );

  // Desktop notification behavior — local-only until the desktop RPC that
  // persists these preferences is wired up.
  const [showInMenuBar, setShowInMenuBar] = useState(true);
  const [playSound, setPlaySound] = useState(true);
  const [badgeCount, setBadgeCount] = useState(true);
  const [doNotDisturb, setDoNotDisturb] = useState(false);

  const onTestNotification = useCallback(() => {
    // Dispatched to the desktop/native bridge; the host listens and fires a
    // real system notification so the user can verify delivery + styling.
    window.dispatchEvent(new CustomEvent("eliza:desktop-notify-test"));
  }, []);

  return (
    <SettingsStack>
      <SettingsGroup
        title="Push Notifications"
        footer="Enable macOS push notifications for agent messages and alerts."
      >
        <NuphySwitchRow
          agentId="notifications-push-toggle"
          agentLabel="Toggle push notifications"
          icon={Bell}
          label="Enable push"
          description={error ?? push.description}
          checked={push.on}
          disabled={!push.canToggle || busy || !ready}
          agentStatus={
            push.canToggle ? (push.on ? "on" : "off") : "unavailable"
          }
          onCheckedChange={onPushToggle}
        />
        <NuphyRow
          label="Status"
          description={push.label}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Notification Behavior"
        footer="Control how notifications appear and sound on this device."
      >
        <NuphySwitchRow
          agentId="notifications-show-in-menu-bar"
          agentLabel="Show notifications in menu bar"
          icon={Bell}
          label="Show in menu bar"
          description="Display incoming notifications in the desktop menu bar."
          checked={showInMenuBar}
          onCheckedChange={setShowInMenuBar}
        />
        <NuphySwitchRow
          agentId="notifications-play-sound"
          agentLabel="Play notification sound"
          icon={Volume2}
          label="Play sound"
          description="Play a sound when a notification arrives."
          checked={playSound}
          onCheckedChange={setPlaySound}
        />
        <NuphySwitchRow
          agentId="notifications-badge-count"
          agentLabel="Show badge count"
          icon={Circle}
          label="Badge count"
          description="Show the unread count as an app badge."
          checked={badgeCount}
          onCheckedChange={setBadgeCount}
        />
        <NuphySwitchRow
          agentId="notifications-do-not-disturb"
          agentLabel="Toggle do not disturb"
          icon={Bell}
          label="Do not disturb"
          description="Silence notifications temporarily."
          checked={doNotDisturb}
          onCheckedChange={setDoNotDisturb}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Test"
        footer="Verify notifications are working end-to-end."
      >
        <NuphyActionButton
          agentId="notifications-send-test"
          agentLabel="Send test notification"
          label="Send test notification"
          buttonLabel="Send test notification"
          onActivate={onTestNotification}
          disabled={!push.on}
          variant="secondary"
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
