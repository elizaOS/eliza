/**
 * Notifications settings section — minimal, tasteful web-push toggle for the
 * installed iOS PWA (16.4+). Uses the shared SettingsSwitchRow so the toggle
 * stays agent-addressable; the whole behavior lives in `useWebPush`. This is
 * intentionally a single toggle + status copy, not new elaborate UX: it lets
 * the user turn on push and reflects the coarse state, degrading gracefully
 * everywhere push isn't available (unsupported browser, non-standalone,
 * unconfigured VAPID).
 */

import { ElizaError } from "@elizaos/core";
import { BellRing } from "lucide-react";
import { useCallback, useState } from "react";
import { invokeDesktopBridgeRequest } from "../../bridge";
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
      const acknowledgement = await invokeDesktopBridgeRequest<{ id: string }>({
        rpcMethod: "desktopShowNotification",
        ipcChannel: "desktop:showNotification",
        params: {
          title: "Eliza Test Notification",
          body: "Notifications from the Eliza desktop app are working.",
        },
      });
      if (
        acknowledgement === null ||
        typeof acknowledgement?.id !== "string" ||
        acknowledgement.id.length === 0
      ) {
        throw new ElizaError(
          "The desktop app cannot send a test notification.",
          { code: "DESKTOP_NOTIFICATION_METHOD_UNAVAILABLE" },
        );
      }
    } catch (cause) {
      // error-policy:J4 the desktop test action renders a visible failure.
      setTestError(
        cause instanceof Error
          ? cause.message
          : "The desktop app cannot send a test notification.",
      );
    } finally {
      setTestBusy(false);
    }
  }, []);

  return (
    <SettingsStack>
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
      {isDesktopPlatform() ? (
        <SettingsGroup
          title="System notification"
          footer="Verify that the desktop app can show system notifications."
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
