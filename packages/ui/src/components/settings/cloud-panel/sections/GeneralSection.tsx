/**
 * Desktop-app integration controls used by the canonical Settings registry.
 *
 * The registry mounts this module only when the desktop bridge capability is
 * present, so portable runtimes never render or mutate placeholder native
 * state.
 */
import * as React from "react";
import { invokeDesktopBridgeRequest } from "../../../../bridge";
import { useAppSelector } from "../../../../state";
import {
  CloudSelectRow,
  CloudSwitchRow,
  SettingsGroup,
  SettingsStack,
} from "../cloud-settings-primitives";

const TRAY_CLICK_OPTIONS = [
  { value: "full-menu", label: "Open menu" },
  { value: "toggle-recording", label: "Toggle recording" },
];

/** Desktop toggle state backed by the Electrobun desktop RPC. */
function useDesktopToggles() {
  const [launchOnLogin, setLaunchOnLogin] = React.useState(false);
  const [showInDock, setShowInDock] = React.useState(true);
  const [recordOnTrayClick, setRecordOnTrayClick] = React.useState(false);
  const [trayClickAction, setTrayClickAction] = React.useState("full-menu");

  // Load current values from the desktop on mount.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const autoLaunch = await invokeDesktopBridgeRequest<{
          enabled: boolean;
          openAsHidden: boolean;
        }>({
          rpcMethod: "desktopGetAutoLaunchStatus",
          ipcChannel: "desktop:getAutoLaunchStatus",
        });
        if (!cancelled && autoLaunch) {
          setLaunchOnLogin(autoLaunch.enabled);
        }
        const dock = await invokeDesktopBridgeRequest<{ visible: boolean }>({
          rpcMethod: "desktopGetDockIconVisibility",
          ipcChannel: "desktop:getDockIconVisibility",
        });
        if (!cancelled && dock) {
          setShowInDock(dock.visible);
        }
      } catch {
        // error-policy:J4 RPC unavailable — defaults render as the
        // designed pre-bridge state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleLaunchOnLogin = React.useCallback(async (enabled: boolean) => {
    setLaunchOnLogin(enabled);
    try {
      await invokeDesktopBridgeRequest<void>({
        rpcMethod: "desktopSetAutoLaunch",
        ipcChannel: "desktop:setAutoLaunch",
        params: { enabled, openAsHidden: false },
      });
    } catch {
      // error-policy:J4 toggle failure reverts the switch visibly.
      setLaunchOnLogin(!enabled);
    }
  }, []);

  const toggleShowInDock = React.useCallback(async (visible: boolean) => {
    setShowInDock(visible);
    try {
      await invokeDesktopBridgeRequest<void>({
        rpcMethod: "desktopSetDockIconVisibility",
        ipcChannel: "desktop:setDockIconVisibility",
        params: { visible },
      });
    } catch {
      // error-policy:J4 toggle failure reverts the switch visibly.
      setShowInDock(!visible);
    }
  }, []);

  return {
    launchOnLogin,
    setLaunchOnLogin: toggleLaunchOnLogin,
    showInDock,
    setShowInDock: toggleShowInDock,
    recordOnTrayClick,
    setRecordOnTrayClick,
    trayClickAction,
    setTrayClickAction,
  };
}

export function DesktopIntegrationSection() {
  const t = useAppSelector((s) => s.t);

  const {
    launchOnLogin,
    setLaunchOnLogin,
    showInDock,
    setShowInDock,
    recordOnTrayClick,
    setRecordOnTrayClick,
    trayClickAction,
    setTrayClickAction,
  } = useDesktopToggles();

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings.desktop", { defaultValue: "Desktop app" })}
        footer="These controls are available when Eliza is running as a desktop app."
      >
        <CloudSwitchRow
          agentId="general-launch-on-login"
          group="general"
          label={t("settings.launchOnLogin", {
            defaultValue: "Open at sign-in",
          })}
          checked={launchOnLogin}
          onCheckedChange={setLaunchOnLogin}
        />
        <CloudSwitchRow
          agentId="general-show-in-dock"
          group="general"
          label={t("settings.showInDock", { defaultValue: "Show app icon" })}
          checked={showInDock}
          onCheckedChange={setShowInDock}
        />
        <CloudSwitchRow
          agentId="general-record-on-tray-click"
          group="general"
          label={t("settings.recordOnTrayClick", {
            defaultValue: "Start recording from the status icon",
          })}
          checked={recordOnTrayClick}
          onCheckedChange={setRecordOnTrayClick}
        />
        {recordOnTrayClick ? (
          <CloudSelectRow
            agentId="general-tray-click-action"
            group="general"
            label={t("settings.trayClickAction", {
              defaultValue: "Status icon action",
            })}
            value={trayClickAction}
            onValueChange={setTrayClickAction}
            options={TRAY_CLICK_OPTIONS}
          />
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  );
}

/** Compatibility export for the retired cloud-panel registry. */
export const GeneralSection = DesktopIntegrationSection;
