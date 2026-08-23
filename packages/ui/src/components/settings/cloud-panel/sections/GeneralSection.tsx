/**
 * General section of the cloud-only desktop settings panel.
 *
 * This cloud-only surface contains only native desktop behavior such as launch
 * on login, Dock visibility, menu bar presence, and tray-click recording.
 */
import * as React from "react";
import { invokeDesktopBridgeRequest } from "../../../../bridge";
import { isDesktopPlatform } from "../../../../platform";
import { useAppSelector } from "../../../../state";
import {
  CloudSelectRow,
  CloudSwitchRow,
  SettingsGroup,
  SettingsStack,
} from "../cloud-settings-primitives";

const TRAY_CLICK_OPTIONS = [
  { value: "full-menu", label: "Full menu" },
  { value: "toggle-recording", label: "Toggle recording" },
];

/** Desktop toggle state backed by the Electrobun desktop RPC. Falls back to
 * local state on non-desktop platforms so the panel still renders. */
function useDesktopToggles() {
  const desktop = isDesktopPlatform();
  const [launchOnLogin, setLaunchOnLogin] = React.useState(false);
  const [showInDock, setShowInDock] = React.useState(true);
  const [recordOnTrayClick, setRecordOnTrayClick] = React.useState(false);
  const [trayClickAction, setTrayClickAction] = React.useState("full-menu");
  const [loaded, setLoaded] = React.useState(false);

  // Load current values from the desktop on mount.
  React.useEffect(() => {
    if (!desktop) {
      setLoaded(true);
      return;
    }
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
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  const toggleLaunchOnLogin = React.useCallback(
    async (enabled: boolean) => {
      setLaunchOnLogin(enabled);
      if (!desktop) return;
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
    },
    [desktop],
  );

  const toggleShowInDock = React.useCallback(
    async (visible: boolean) => {
      setShowInDock(visible);
      if (!desktop) return;
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
    },
    [desktop],
  );

  return {
    loaded,
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

export function GeneralSection() {
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
        title={t("settings.desktop", { defaultValue: "Desktop" })}
        footer="Control how Eliza integrates with macOS."
      >
        <CloudSwitchRow
          agentId="general-launch-on-login"
          group="general"
          label={t("settings.launchOnLogin", {
            defaultValue: "Launch on login",
          })}
          checked={launchOnLogin}
          onCheckedChange={setLaunchOnLogin}
        />
        <CloudSwitchRow
          agentId="general-show-in-dock"
          group="general"
          label={t("settings.showInDock", { defaultValue: "Show in Dock" })}
          checked={showInDock}
          onCheckedChange={setShowInDock}
        />
        <CloudSwitchRow
          agentId="general-record-on-tray-click"
          group="general"
          label={t("settings.recordOnTrayClick", {
            defaultValue: "Start recording on menu bar click",
          })}
          checked={recordOnTrayClick}
          onCheckedChange={setRecordOnTrayClick}
        />
        {recordOnTrayClick ? (
          <CloudSelectRow
            agentId="general-tray-click-action"
            group="general"
            label={t("settings.trayClickAction", {
              defaultValue: "Click to open",
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
