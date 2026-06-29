// Self-contained fixture for the in-chat first-run e2e (#9952). Mounts the real
// FirstRunChat (the seeded greeting + in-chat ChoiceWidget / CredentialRequest
// widgets, with the first-run controller + app-store stubbed) over a brand
// backdrop so a headless browser can drive both the cloud and local paths and
// screenshot every state. Paired with run-onboarding-e2e.mjs.
import * as React from "react";
import { createRoot } from "react-dom/client";

import { FirstRunChat } from "../FirstRunChat";

function Harness(): React.JSX.Element {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // Brand backdrop the in-chat first-run flow is designed to sit over
        // (white text + #FF5800 accents).
        background:
          "radial-gradient(120% 100% at 50% 0%, #ff8a3d 0%, #ff5800 55%, #c63f00 100%)",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <FirstRunChat />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
