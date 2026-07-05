/**
 * Fixture for the DEEP (real-browser) widget-cert layer (#14380). Renders the
 * representative widgets on a mobile-sized page so the playwright runner can
 * run the SAME `certifyWidget` sweep against real layout + computed style via
 * the live geometry provider. Kept minimal + dependency-light so it bundles the
 * same way the other `__e2e__` fixtures do (esbuild IIFE, no app runtime).
 *
 * The runner reads `window.__widgetCert` to drive certification in-page.
 */

import { createRoot } from "react-dom/client";

import { Button } from "../../components/ui/button";
import {
  certifyWidget,
  liveGeometryProvider,
  type WidgetCertReport,
} from "../widget-cert";

declare global {
  interface Window {
    __widgetCert: {
      ready: boolean;
      /** Certify every mounted widget and return the reports. */
      run: () => WidgetCertReport[];
    };
  }
}

/** A tall, button-dense, scrollable demo surface. */
function DemoScreen() {
  const rows = Array.from({ length: 40 }, (_, i) => i);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* button-dense demo view */}
      <div
        data-testid="demo-buttons"
        style={{ display: "flex", gap: 8, padding: 12, flexWrap: "wrap" }}
      >
        <Button data-testid="btn-lg" size="lg">
          Large
        </Button>
        <Button data-testid="btn-default">Default</Button>
        <Button data-testid="btn-sm" size="sm">
          Small
        </Button>
        <Button data-testid="btn-icon" size="icon" aria-label="icon">
          i
        </Button>
        <Button data-testid="btn-icon-sm" size="icon-sm" aria-label="small">
          s
        </Button>
      </div>
      {/* scrollable transcript / list */}
      <div
        id="continuous-thread"
        data-scroll-cert-scroller
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehavior: "contain",
        }}
      >
        {rows.map((i) => (
          <button
            key={i}
            data-testid={`row-${i}`}
            style={{
              display: "block",
              width: "100%",
              height: 56,
              textAlign: "left",
            }}
          >
            row {i}
          </button>
        ))}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<DemoScreen />);
  window.__widgetCert = {
    ready: true,
    run() {
      const provider = liveGeometryProvider(window);
      const reports: WidgetCertReport[] = [];
      const demo = document.querySelector('[data-testid="demo-buttons"]');
      if (demo) {
        reports.push(
          certifyWidget("demo-buttons", demo, provider, {
            dimensions: ["tap-target"],
          }),
        );
      }
      const thread = document.querySelector("#continuous-thread");
      if (thread) {
        reports.push(
          certifyWidget("transcript", thread, provider, {
            dimensions: ["scroll", "tap-target"],
            nestedScrollers: { "#continuous-thread": true },
          }),
        );
      }
      return reports;
    },
  };
}
