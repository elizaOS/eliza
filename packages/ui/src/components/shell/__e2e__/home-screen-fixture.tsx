/**
 * Mounts the real HomeScreen, notification center, and plugin widgets for
 * browser interaction tests. Deterministic API data and hydrated stores model
 * both quiet and attention states before the first render.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { __setHydratedForTests } from "../../../state/notifications/notification-store";

import {
  installHomeWidgetFetchMock,
  seedHomeWidgetAppStore,
  seedHomeWidgetNotifications,
} from "../../../widgets/__fixtures__/home-widget-mock-data";
import { ShaderBackground } from "../../../backgrounds/ShaderBackground";
import { RoleProvider } from "../../../hooks/useRole";
import { LauncherSurface } from "../../pages/LauncherSurface";
import { HomeLauncherSurface } from "../HomeLauncherSurface";
import { HomeScreen, type HomeTileTarget } from "../HomeScreen";

// Inject the home-widget data BEFORE the React tree renders so every widget's
// mount-time fetch + the WidgetHost's plugin resolution see populated data.
seedHomeWidgetAppStore();
seedHomeWidgetNotifications();
installHomeWidgetFetchMock();
__setHydratedForTests(true);

const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const showNativeOsTiles = params.has("native");

function Harness(): React.JSX.Element {
  return (
    <RoleProvider role="OWNER">
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
    </RoleProvider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
