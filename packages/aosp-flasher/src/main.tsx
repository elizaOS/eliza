import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InstallerShell } from "./components/InstallerShell";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <InstallerShell serverUrl="http://localhost:3743" />
  </StrictMode>,
);
