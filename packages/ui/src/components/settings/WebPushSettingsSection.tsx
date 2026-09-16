/**
 * Provides a native notification delivery test and browser push opt-in.
 * Native permissions remain in the device permission rows; the test never
 * requests another grant or substitutes an in-app toast for OS delivery.
 */

import { Capacitor } from "@capacitor/core";
import { BellRing } from "lucide-react";
import { useCallback, useState } from "react";
import { deliverSystemNotification } from "../../bridge/notification-delivery";
import { isDesktopPlatform } from "../../platform";
import { useWebPush } from "../../state/notifications/useWebPush";
import { SettingsActionButton, SettingsSwitchRow } from "./settings-agent-rows";
import { SettingsGroup, SettingsStack } from "./settings-layout";

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
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const view = describeState(state);
  const native = isDesktopPlatform() || Capacitor.isNativePlatform();

  const onToggle = useCallback(
    (checked: boolean) => {
      // Called from the Switch's click — inside the user gesture (iOS requires
      // the permission prompt + subscribe to run in the gesture task).
      if (checked) void subscribe();
      else void unsubscribe();
    },
    [subscribe, unsubscribe],
  );

  const onTestNotification = useCallback(async () => {
    setTestBusy(true);
    setTestError(null);
    try {
      const channel = await deliverSystemNotification({
        id: `notification-test-${crypto.randomUUID()}`,
        title: "Eliza Test Notification",
        body: "Notifications from Eliza are working.",
        priority: "normal",
        requestPermission: false,
      });
      if (channel === "none") {
        setTestError(
          "Cannot send a system notification. Check notification access above and in your device settings.",
        );
      }
    } catch (cause) {
      // error-policy:J4 the notification test renders a visible failure.
      setTestError(
        cause instanceof Error
          ? cause.message
          : "Cannot send a system notification.",
      );
    } finally {
      setTestBusy(false);
    }
  }, []);

  return (
    <SettingsStack>
      {!native && (
        <SettingsGroup title="Notifications">
          <SettingsSwitchRow
            agentId="notifications-push-toggle"
            agentLabel="Toggle push notifications"
            icon={BellRing}
            label={view.label}
            description={error ?? view.description}
            checked={view.on}
            disabled={!view.canToggle || busy || !ready}
            agentStatus={
              view.canToggle ? (view.on ? "on" : "off") : "unavailable"
            }
            onCheckedChange={onToggle}
          />
        </SettingsGroup>
      )}
      {native ? (
        <SettingsGroup
          title="System notification"
          footer="Send a test banner. Your device controls its placement and may silence it during Focus or Do Not Disturb."
        >
          <div className="px-5 py-3">
            <SettingsActionButton
              agentId="notifications-send-test"
              agentLabel="Send test notification"
              agentGroup="notifications"
              variant="outline"
              size="sm"
              disabled={testBusy}
              agentStatus={testError ? "error" : testBusy ? "sending" : "ready"}
              onClick={() => void onTestNotification()}
            >
              Send test notification
            </SettingsActionButton>
            {testError ? (
              <p className="mt-2 text-xs text-danger" role="alert">
                {testError}
              </p>
            ) : null}
          </div>
        </SettingsGroup>
      ) : null}
    </SettingsStack>
  );
}
