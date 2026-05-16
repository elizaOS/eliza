import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@elizaos/ui/styles";
import { App } from "./App.tsx";
import "./stories.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element missing");
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
