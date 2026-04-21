import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./shims/process";
import { ErrorBoundary } from "./components/ErrorBoundary";

function renderFatal(error: Error): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) return;
  const msg = error.stack ?? error.message;
  rootEl.innerHTML = `
    <div style="
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      padding: 16px;
      color: rgba(255,255,255,0.92);
      background: #0b0f14;
      min-height: 100vh;
      box-sizing: border-box;
    ">
      <div style="font-weight: 800; margin-bottom: 10px;">Startup error</div>
      <pre style="white-space: pre-wrap; color: rgba(255,255,255,0.85);">${msg}</pre>
      <div style="opacity: 0.8; margin-top: 10px;">Share this error text and we’ll fix it.</div>
    </div>
  `;
}

async function main(): Promise<void> {
  try {
    const mod = await import("./App");
    const App = mod.default;
    const root = document.getElementById("root");
    if (!root) throw new Error("Missing #root element");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    renderFatal(err);
  }
}

void main();

