import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdbFlasherBackend } from "./backend/adb-backend";
import { FlasherApp } from "./components/FlasherApp";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

const backend = new AdbFlasherBackend();

createRoot(root).render(
  <StrictMode>
    <FlasherApp backend={backend} />
  </StrictMode>,
);
