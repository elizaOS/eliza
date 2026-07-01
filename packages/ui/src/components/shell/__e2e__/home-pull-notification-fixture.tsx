// Fixture for the pull-down notification-center e2e (#10706): mounts the REAL
// HomeScreen inside the REAL HomeLauncherSurface (home ↔ launcher horizontal
// pager) wired with `onNotificationCenterOpen`, plus the REAL
// NotificationCenterPanel. Seeds a mixed-attention notification set directly
// into the store (bypassing WS) so the panel's priority↔time sort toggle has
// real data. Paired with run-home-pull-notification-e2e.mjs.
//
// The point of the e2e: a pull-DOWN on the `home-screen` div opens the panel
// (distinct from the chat sheet's bottom grabber), the sort toggle is present,
// and — critically — the home↔launcher HORIZONTAL swipes still work afterward
// (the two gestures do not fight: the pull gesture axis-locks vertical and
// cedes the pointer to the parent pager the instant a drag commits horizontal).

import * as React from "react";
import { createRoot } from "react-dom/client";

import { ShaderBackground } from "../../../backgrounds/ShaderBackground";
import {
  installHomeWidgetFetchMock,
  seedHomeWidgetAppStore,
} from "../../../widgets/__fixtures__/home-widget-mock-data";
import { LauncherSurface } from "../../pages/LauncherSurface";
import { HomeLauncherSurface } from "../HomeLauncherSurface";
import { HomeScreen, type HomeTileTarget } from "../HomeScreen";
import { NotificationCenterPanel } from "../NotificationCenterPanel";

// Seed the home-WIDGET data sources (app-store snapshot + window.fetch) so the
// real home cards render. The NOTIFICATION store the panel reads hydrates
// separately from the pull-down api-stub's `listNotifications` (mixed-attention
// set) when the panel's NotificationCenter mounts.
seedHomeWidgetAppStore();
installHomeWidgetFetchMock();

const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const showNativeOsTiles = params.has("native");

function Harness(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div
      data-testid="home-pull-fixture-root"
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
            onNotificationCenterOpen={() => setOpen(true)}
          />
        }
        launcher={<LauncherSurface />}
      />
      <NotificationCenterPanel isOpen={open} onClose={() => setOpen(false)} />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
