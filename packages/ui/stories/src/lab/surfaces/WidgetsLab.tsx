/**
 * Home / widgets surface for the Design Lab: mounts the REAL HomeScreen — its
 * unified WidgetHost, per-plugin widgets, and the pinned notification center —
 * plus the launcher half, over the real ShaderBackground. The widgets are fed by
 * injected mock data (app-store snapshot + notification store + a window.fetch
 * mock), seeded at module load BEFORE first render so every widget's mount-time
 * fetch resolves — the same seeding the home-screen e2e fixture uses.
 */

import { ShaderBackground } from "@ui-src/backgrounds/ShaderBackground";
import { LauncherSurface } from "@ui-src/components/pages/LauncherSurface";
import { HomeLauncherSurface } from "@ui-src/components/shell/HomeLauncherSurface";
import { HomeScreen } from "@ui-src/components/shell/HomeScreen";
import {
  installHomeWidgetFetchMock,
  seedHomeWidgetAppStore,
  seedHomeWidgetNotifications,
} from "@ui-src/widgets/__fixtures__/home-widget-mock-data";
import * as React from "react";
import { createPortal } from "react-dom";

import { ControlGroup, Hint, Row, Segmented, Toggle } from "../lab-ui";

// Seed once at module load so the widget data is present the first time the
// surface mounts (widgets fetch on mount). Idempotent re-seeds are cheap.
seedHomeWidgetAppStore();
seedHomeWidgetNotifications();
installHomeWidgetFetchMock();

type Half = "home" | "launcher";

export function WidgetsLab({ controlsEl }: { controlsEl: HTMLElement | null }) {
  const [half, setHalf] = React.useState<Half>("home");
  const [nativeTiles, setNativeTiles] = React.useState(false);
  // Remount key so "reseed" re-runs the widgets' mount-time data resolution.
  const [seedKey, setSeedKey] = React.useState(0);

  const controls = (
    <>
      <ControlGroup label="Surface">
        <Segmented
          value={half}
          options={[
            { value: "home", label: "Home widgets" },
            { value: "launcher", label: "Launcher" },
          ]}
          onChange={setHalf}
        />
        <Hint>
          The home/launcher rail is a horizontal swipe in the app; pick a half
          here to jump straight to it.
        </Hint>
      </ControlGroup>
      <ControlGroup label="Options">
        <Toggle
          label="Native OS tiles (AOSP)"
          checked={nativeTiles}
          onChange={setNativeTiles}
        />
        <Row>
          <button
            type="button"
            className="lab-action"
            onClick={() => {
              seedHomeWidgetAppStore();
              seedHomeWidgetNotifications();
              setSeedKey((k) => k + 1);
            }}
          >
            Reseed widgets
          </button>
        </Row>
      </ControlGroup>
    </>
  );

  return (
    <>
      <ShaderBackground />
      <HomeLauncherSurface
        key={seedKey}
        initialPage={half}
        home={
          <HomeScreen
            onOpenTile={(t) =>
              // eslint-disable-next-line no-console
              console.log("[lab] open tile", t)
            }
            showNativeOsTiles={nativeTiles}
          />
        }
        launcher={<LauncherSurface />}
      />
      {controlsEl ? createPortal(controls, controlsEl) : null}
    </>
  );
}
