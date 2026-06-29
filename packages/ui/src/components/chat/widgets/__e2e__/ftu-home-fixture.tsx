/**
 * Fixture for the FTU welcome lifecycle e2e (run-ftu-home-e2e.mjs). Mounts the
 * REAL {@link FTU_WELCOME_HOME_WIDGET} behind a faithful copy of WidgetHost's
 * home-slot sunset gate (`isHomeWidgetSunset` over the live `useHomeDismissals`
 * store), on a stand-in home grid (clock + the FTU card). Tapping a chip or the
 * dismiss control retires the card exactly as it would on the real home, and the
 * retirement persists in `localStorage` — so the runner can prove cold → engage
 * → retired → (reload) still-retired.
 *
 * `usePromptSuggestions` is stubbed by the runner (esbuild) to fixed chips so the
 * fixture needs no API client / network.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  isHomeWidgetSunset,
  useHomeDismissals,
} from "../../../../widgets/home-dismissal-store";
import { FTU_WELCOME_HOME_WIDGET } from "../ftu-welcome";

const KEY = `${FTU_WELCOME_HOME_WIDGET.pluginId}/${FTU_WELCOME_HOME_WIDGET.id}`;
const { Component: FtuWelcome, sunset } = FTU_WELCOME_HOME_WIDGET;

function HomeGrid(): React.JSX.Element {
  const dismissals = useHomeDismissals();
  const retired = isHomeWidgetSunset(KEY, sunset, dismissals);
  return (
    <div
      data-testid="home-grid"
      data-ftu-retired={retired ? "true" : "false"}
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 12,
        padding: 16,
        alignContent: "start",
      }}
    >
      {/* Tier 1 ambient base stand-in. */}
      <div
        data-testid="home-clock"
        style={{ gridColumn: "span 4", color: "#fff", fontSize: 40, fontWeight: 700 }}
      >
        9:41
      </div>
      {retired ? (
        <div
          data-testid="ftu-retired"
          style={{ gridColumn: "span 4", color: "rgba(255,255,255,0.5)" }}
        >
          (welcome card retired)
        </div>
      ) : (
        <FtuWelcome slot="home" />
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<HomeGrid />);
