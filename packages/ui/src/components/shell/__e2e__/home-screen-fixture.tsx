// Fixture for the home-screen e2e: mounts the REAL HomeScreen — including the
// REAL unified home-slot WidgetHost (#9143), its per-plugin widget components,
// and the pinned dashboard notification center (NotificationsHomeCenter) — over
// the real ShaderBackground (flat orange + edge pulse). The widgets are fed by
// injected DATA only: the app-store plugins snapshot + notification store are
// seeded, and `window.fetch` is mocked, all BEFORE first render so the widgets
// resolve and populate on mount. Paired with run-home-screen-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";

import {
  installHomeWidgetFetchMock,
  HOME_WIDGET_MOCK_NOTIFICATION,
  seedHomeWidgetAppStore,
  seedHomeWidgetNotifications,
} from "../../../widgets/__fixtures__/home-widget-mock-data";
import { __ingestNotificationForTests } from "../../../state/notifications/notification-store";
import { ShaderBackground } from "../../../backgrounds/ShaderBackground";
import { LauncherSurface } from "../../pages/LauncherSurface";
import { HomeLauncherSurface } from "../HomeLauncherSurface";
import { HomeScreen, type HomeTileTarget } from "../HomeScreen";

// Inject the home-widget data BEFORE the React tree renders so every widget's
// mount-time fetch + the WidgetHost's plugin resolution see populated data.
seedHomeWidgetAppStore();
seedHomeWidgetNotifications();
installHomeWidgetFetchMock();

const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
if (params.has("dense-notifications")) {
  for (const [index, source] of [
    "github",
    "mail",
    "calendar",
    "files",
    "workflow",
    "orchestrator",
  ].entries()) {
    __ingestNotificationForTests(
      {
        ...HOME_WIDGET_MOCK_NOTIFICATION,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        title: `Priority notification ${index + 2}`,
        source,
        createdAt: HOME_WIDGET_MOCK_NOTIFICATION.createdAt - index - 1,
      },
      index + 2,
    );
  }
}
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
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
