import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HttpAospFlasherBackend } from "./backend/http-backend";
import { FlasherApp } from "./components/FlasherApp";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

// In Electrobun the renderer can't spawn processes directly.
// We always use the HTTP backend which proxies through the Bun server.
const backend = new HttpAospFlasherBackend("/api");

createRoot(root).render(
  <StrictMode>
    <FlasherApp backend={backend} />
  </StrictMode>,
);
