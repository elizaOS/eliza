import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HttpUsbInstallerBackend } from "./backend/http-backend";
import { InstallerApp } from "./components/InstallerApp";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

// In Electrobun (desktop app) the native IPC backend is available.
// In all browser contexts (Vite dev server or static deployment) use the
// HTTP backend which talks to the local Bun server via the /api Vite proxy.
const isElectrobun =
  typeof (globalThis as Record<string, unknown>)["electrobun"] !== "undefined";

async function main() {
  let backend;
  if (isElectrobun) {
    const { createPlatformBackend } = await import("./backend/index");
    backend = createPlatformBackend();
  } else {
    backend = new HttpUsbInstallerBackend();
  }

  createRoot(root!).render(
    <StrictMode>
      <InstallerApp backend={backend} />
    </StrictMode>,
  );
}

void main();
