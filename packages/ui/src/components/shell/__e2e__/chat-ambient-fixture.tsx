// Self-contained fixture for the ambient shader-background e2e. Mounts the real
// ShaderBackground full-bleed so a headless browser can screenshot the gentle
// warm-white ↔ brand-orange rim pulse across the animation. Paired with
// run-chat-ambient-e2e.mjs.
import * as React from "react";
import { createRoot } from "react-dom/client";

import { ShaderBackground } from "../../../backgrounds/ShaderBackground";

function Harness(): React.JSX.Element {
  return (
    <div
      style={{ position: "fixed", inset: 0, overflow: "hidden" }}
      data-testid="chat-ambient-host"
    >
      <ShaderBackground />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
