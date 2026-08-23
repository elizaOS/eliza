/**
 * Notifications section for the cloud-only settings panel. Combines the shared
 * web-push toggle (reusing `useWebPush`) with desktop notification behavior
 * switches and a test-notification action. The behavior toggles are local state
 * for now — the desktop RPC that persists them still needs to be wired, so they
 * only reflect in-session preferences until that lands.
 */

import { Bell } from "lucide-react";
import { useCallback } from "react";
import { invokeDesktopBridgeRequest } from "../../../../bridge";
import { isDesktopPlatform } from "../../../../platform";
import { useWebPush } from "../../../../state/notifications/useWebPush";
import {
  CloudActionButton,
  CloudRow,
  CloudSwitchRow,
  SettingsGroup,
  SettingsStack,
} from "../cloud-settings-primitives";

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
        description: isDesktopPlatform()
          ? "Web push is not available in this desktop build. System notifications can still be tested below."
          : "Install this app on a supported device to enable web push.",
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

  const onTestNotification = useCallback(() => {
    if (isDesktopPlatform()) {
      // On desktop, fire a real system notification through the desktop bridge.
      void invokeDesktopBridgeRequest<void>({
        rpcMethod: "desktopShowNotification",
        ipcChannel: "desktop:showNotification",
        params: {
          title: "Eliza — Test Notification",
          body: "If you can see this, notifications are working correctly.",
        },
      });
    } else {
      // Web/iOS fallback: dispatch a DOM event the host listens for.
      window.dispatchEvent(new CustomEvent("eliza:desktop-notify-test"));
    }
  }, []);

  return (
    <SettingsStack>
      <SettingsGroup
        title="Push Notifications"
        footer="Enable macOS push notifications for agent messages and alerts."
      >
        <CloudSwitchRow
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
        <CloudRow label="Status" description={push.label} />
      </SettingsGroup>

      <SettingsGroup
        title="Test"
        footer="Verify notifications are working end-to-end."
      >
        <CloudActionButton
          agentId="notifications-send-test"
          agentLabel="Send test notification"
          label="Send test notification"
          buttonLabel="Send test notification"
          onActivate={onTestNotification}
          disabled={!push.on && !isDesktopPlatform()}
          variant="secondary"
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
