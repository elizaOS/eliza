// Exposes the AOSP setup flasher entrypoint and public surface.
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-700.css";
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
