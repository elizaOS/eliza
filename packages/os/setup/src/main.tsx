import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InstallerShell } from "./components/InstallerShell";
import { getServerUrl } from "./runtime/server-url";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <InstallerShell serverUrl={getServerUrl()} />
  </StrictMode>,
);
