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
import { SpringboardSurface } from "../../pages/SpringboardSurface";
import { HomeSpringboardSurface } from "../HomeSpringboardSurface";
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
const showNativeOsTiles = params.has("native");

function Harness(): React.JSX.Element {
  return (
    <div
      data-testid="home-fixture-root"
      style={{ position: "fixed", inset: 0, overflow: "hidden" }}
    >
      <ShaderBackground />
      <HomeSpringboardSurface
        home={
          <HomeScreen
            onOpenTile={(t: HomeTileTarget) =>
              console.log(`[fixture] open ${JSON.stringify(t)}`)
            }
            showNativeOsTiles={showNativeOsTiles}
          />
        }
        springboard={<SpringboardSurface />}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
