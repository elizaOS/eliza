// Fixture for the home-screen e2e: mounts the real HomeScreen over the real
// ShaderBackground (flat orange + edge pulse), with stubbed data sources
// (see the esbuild redirects in run-home-screen-e2e.mjs). Paired with that runner.

import * as React from "react";
import { createRoot } from "react-dom/client";

import { ShaderBackground } from "../../../backgrounds/ShaderBackground";
import { SpringboardSurface } from "../../pages/SpringboardSurface";
import { HomeSpringboardSurface } from "../HomeSpringboardSurface";
import { HomeScreen, type HomeTileTarget } from "../HomeScreen";

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
