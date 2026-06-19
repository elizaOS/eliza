import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const APP_NAME = "__APP_DISPLAY_NAME__";

function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Hello from {APP_NAME}</h1>
      <p>
        This Eliza app was scaffolded from{" "}
        <code>packages/elizaos/templates/min-project</code>.
      </p>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
