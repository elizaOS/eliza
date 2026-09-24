// Exposes the USB installer app entrypoint and backend surface.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HttpUsbInstallerBackend } from "./backend/http-backend";
import { InstallerApp } from "./components/InstallerApp";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

const rootElement: HTMLElement = root;

// Keep raw disk enumeration and write execution out of the renderer bundle.
// The browser/Electrobun view talks to the local backend contract; platform
// helpers stay in server.ts or a future signed privileged helper.
const backend = new HttpUsbInstallerBackend();

createRoot(rootElement).render(
  <StrictMode>
    <InstallerApp backend={backend} />
  </StrictMode>,
);
