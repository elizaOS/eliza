// Fixture for the home-screen e2e: mounts the REAL HomeScreen — including the
// REAL unified home-slot WidgetHost (#9143) and its per-plugin widget components
// — over the real ShaderBackground (flat orange + edge pulse). The widgets are
// fed by injected DATA only: the app-store plugins snapshot + notification store
// are seeded, and `window.fetch` is mocked, all BEFORE first render so the
// widgets resolve and populate on mount. Paired with run-home-screen-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";

import {
  installHomeWidgetFetchMock,
  seedHomeWidgetAppStore,
  seedHomeWidgetNotifications,
} from "../../../widgets/__fixtures__/home-widget-mock-data";
import { ShaderBackground } from "../../../backgrounds/ShaderBackground";
import { LauncherSurface } from "../../pages/LauncherSurface";
import { HomeLauncherSurface } from "../HomeLauncherSurface";
import { HomeScreen, type HomeTileTarget } from "../HomeScreen";
import { NotificationCenter } from "../NotificationCenter";

// Inject the home-widget data BEFORE the React tree renders so every widget's
// mount-time fetch + the WidgetHost's plugin resolution see populated data.
seedHomeWidgetAppStore();
seedHomeWidgetNotifications();
installHomeWidgetFetchMock();

const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const showNativeOsTiles = params.has("native");

function Harness(): React.JSX.Element {
  return (
    <div
      data-testid="home-fixture-root"
      style={{ position: "fixed", inset: 0, overflow: "hidden" }}
    >
      <ShaderBackground />
      <HomeLauncherSurface
        home={
          <HomeScreen
            onOpenTile={(t: HomeTileTarget) =>
              console.log(`[fixture] open ${JSON.stringify(t)}`)
            }
            showNativeOsTiles={showNativeOsTiles}
          />
        }
        launcher={<LauncherSurface />}
      />
      {/* The single always-mounted notification owner (mirrors App.tsx). The
          home pull-down + pull-zone button dispatch OPEN_NOTIFICATION_CENTER_EVENT;
          this headless instance is the sole renderer of the sheet/panel. */}
      <NotificationCenter headless />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
