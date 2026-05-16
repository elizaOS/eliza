import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DryRunUsbInstallerBackend } from "./backend/dry-run-backend";
import { InstallerApp } from "./components/InstallerApp";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <InstallerApp backend={new DryRunUsbInstallerBackend()} />
  </StrictMode>,
);
