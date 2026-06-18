// Self-contained fixture for the onboarding e2e. Mounts the real
// CompactOnboarding (the first-run card, with the first-run controller stubbed)
// over a brand backdrop, so a headless browser can screenshot every state.
// Paired with run-onboarding-e2e.mjs.
import * as React from "react";
import { createRoot } from "react-dom/client";

import { CompactOnboarding } from "../CompactOnboarding";

function Harness(): React.JSX.Element {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // Brand backdrop the onboarding card is designed to sit over (white text
        // + #FF5800 accents).
        background:
          "radial-gradient(120% 100% at 50% 0%, #ff8a3d 0%, #ff5800 55%, #c63f00 100%)",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <CompactOnboarding />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
