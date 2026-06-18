// Self-contained fixture for the chat ambient-background e2e. Mounts the real
// ChatAmbientBackground full-bleed so a headless browser can screenshot the
// gentle orange→blue→black→white pulse across the animation. Paired with
// run-chat-ambient-e2e.mjs.
import * as React from "react";
import { createRoot } from "react-dom/client";

import { ChatAmbientBackground } from "../ChatAmbientBackground";

function Harness(): React.JSX.Element {
  return (
    <div
      style={{ position: "fixed", inset: 0, overflow: "hidden" }}
      data-testid="chat-ambient-host"
    >
      <ChatAmbientBackground />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
