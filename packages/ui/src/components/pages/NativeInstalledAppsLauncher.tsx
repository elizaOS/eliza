/** AOSP composition of registered Eliza views and the current Android app inventory. */
import { System } from "@elizaos/capacitor-system";
import {
  appKey,
  createLauncher,
  createSystemLauncherBridge,
  type LauncherBridge,
  localFavorites,
  observeLauncher,
} from "@elizaos/capacitor-system/launcher";
import * as React from "react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useBranding } from "../../config/branding-react.hooks";
import type { ViewEntry } from "../../hooks/view-catalog";
import { LauncherAppIcon } from "../views/LauncherAppIcon";
import { InstalledAppsLauncher } from "./InstalledAppsLauncher";

export function NativeInstalledAppsLauncher({
  entries,
  onLaunch,
  error,
  loading,
  active = true,
  onRetry,
}: {
  entries: ViewEntry[];
  onLaunch: (entry: ViewEntry) => void | Promise<void>;
  error: Error | null;
  loading: boolean;
  active?: boolean;
  onRetry: () => void;
}) {
  const { appName } = useBranding();
  const [, changed] = useReducer((value: number) => value + 1, 0);
  const [query, setQuery] = useState("");
  const currentEntries = useRef(new Map<string, ViewEntry>());
  const launch = useRef(onLaunch);
  launch.current = onLaunch;
  currentEntries.current = new Map(
    entries.map((entry) => [`eliza:${entry.id}`, entry]),
  );
  const controller = useMemo(() => {
    const system = createSystemLauncherBridge(System);
    // Registered views open in the shell; only installed apps reach Android.
    const bridge: LauncherBridge = {
      ...system,
      launch: async (target) => {
        const builtin = currentEntries.current.get(appKey(target));
        if (builtin) {
          await launch.current(builtin);
          return;
        }
        await system.launch(target);
      },
    };
    return {
      launcher: createLauncher(bridge, changed, {
        icons: true,
        favorites: localFavorites(),
      }),
      bridge,
    };
  }, []);
  controller.launcher.setBuiltins(
    entries.map((entry) => ({
      packageName: `eliza:${entry.id}`,
      label: entry.label,
    })),
  );
  useEffect(() => {
    if (!active || loading) return;
    const stop = observeLauncher(controller.bridge, controller.launcher);
    void controller.launcher.load();
    return () => {
      stop();
      controller.launcher.cancelPending();
    };
  }, [controller, loading, active]);
  return (
    <React.Fragment>
      {error && (
        <p role="alert">
          {error.message}{" "}
          <button type="button" onClick={onRetry}>
            Retry {appName} apps
          </button>
        </p>
      )}
      <InstalledAppsLauncher
        launcher={controller.launcher}
        query={query}
        onQuery={setQuery}
        productName={appName}
        aria-label="All apps"
        style={{
          height: "100%",
          paddingBottom: "var(--eliza-composer-clearance,6rem)",
        }}
        renderIcon={(app) => {
          const entry = currentEntries.current.get(appKey(app));
          return entry ? (
            <LauncherAppIcon entry={entry} className="size-11" />
          ) : undefined;
        }}
      />
    </React.Fragment>
  );
}
