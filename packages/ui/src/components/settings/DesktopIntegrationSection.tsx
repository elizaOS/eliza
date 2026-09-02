/**
 * Desktop-app integration controls used by the canonical Settings registry.
 *
 * The registry mounts this module only when the desktop bridge capability is
 * present, so portable runtimes never render or mutate placeholder native
 * state.
 */

import { ElizaError } from "@elizaos/core";
import * as React from "react";
import { invokeDesktopBridgeRequest } from "../../bridge";
import { useAppSelector } from "../../state";
import { SettingsSwitchRow } from "./settings-agent-rows";
import { SettingsGroup, SettingsStack } from "./settings-layout";

/** Launch-at-login state backed by the Electrobun desktop RPC. */
function useLaunchAtLogin() {
  const [launchOnLogin, setLaunchOnLogin] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [available, setAvailable] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const mutationInFlight = React.useRef(false);

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
        if (
          autoLaunch === null ||
          typeof autoLaunch.enabled !== "boolean" ||
          typeof autoLaunch.openAsHidden !== "boolean"
        ) {
          throw new ElizaError("Unable to read the desktop setting.", {
            code: "DESKTOP_AUTO_LAUNCH_STATUS_UNAVAILABLE",
          });
        }
        if (!cancelled) {
          setLaunchOnLogin(autoLaunch.enabled);
          setAvailable(true);
          setError(null);
        }
      } catch (cause) {
        // error-policy:J4 bridge failures render a distinct unavailable state.
        if (!cancelled) {
          setAvailable(false);
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to read the desktop setting.",
          );
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleLaunchOnLogin = React.useCallback(
    async (enabled: boolean) => {
      if (mutationInFlight.current) return;
      mutationInFlight.current = true;
      const previous = launchOnLogin;
      setLaunchOnLogin(enabled);
      setBusy(true);
      setError(null);
      try {
        const acknowledgement = await invokeDesktopBridgeRequest<void>({
          rpcMethod: "desktopSetAutoLaunch",
          ipcChannel: "desktop:setAutoLaunch",
          params: { enabled, openAsHidden: false },
        });
        if (acknowledgement === null) {
          throw new ElizaError("Unable to update the desktop setting.", {
            code: "DESKTOP_AUTO_LAUNCH_MUTATION_UNAVAILABLE",
          });
        }
      } catch (cause) {
        // error-policy:J4 toggle failure reverts the switch visibly.
        setLaunchOnLogin(previous);
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to update the desktop setting.",
        );
      } finally {
        mutationInFlight.current = false;
        setBusy(false);
      }
    },
    [launchOnLogin],
  );

  return {
    launchOnLogin,
    setLaunchOnLogin: toggleLaunchOnLogin,
    loaded,
    available,
    busy,
    error,
  };
}

export function DesktopIntegrationSection() {
  const t = useAppSelector((s) => s.t);

  const { launchOnLogin, setLaunchOnLogin, loaded, available, busy, error } =
    useLaunchAtLogin();

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings.desktop", { defaultValue: "Desktop app" })}
        footer="These controls are available when Eliza is running as a desktop app."
      >
        <SettingsSwitchRow
          agentId="general-launch-on-login"
          group="general"
          label={t("settings.launchOnLogin", {
            defaultValue: "Open at sign-in",
          })}
          description={error ?? undefined}
          checked={launchOnLogin}
          disabled={!loaded || !available || busy}
          agentStatus={error ? "unavailable" : undefined}
          testId="desktop-launch-at-login"
          onCheckedChange={setLaunchOnLogin}
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
