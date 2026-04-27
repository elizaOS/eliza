/**
 * Counter app UI — minimal Vite + React shell. Source of truth for the
 * value lives server-side via the plugin's INCREMENT_COUNTER /
 * DECREMENT_COUNTER / GET_COUNTER / RESET_COUNTER actions; this UI keeps
 * a local mirror in localStorage so the +/− buttons feel snappy and
 * survive a reload even when the API is unreachable.
 */

import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const APP_NAME = "Counter";

function readCount(): number {
  try {
    const raw = window.localStorage.getItem("app-counter:count");
    if (raw == null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeCount(next: number): void {
  try {
    window.localStorage.setItem("app-counter:count", String(next));
  } catch {
    // best-effort
  }
}

function App() {
  const [count, setCount] = useState<number>(() => readCount());

  useEffect(() => {
    writeCount(count);
  }, [count]);

  const increment = useCallback(() => setCount((c) => c + 1), []);
  const decrement = useCallback(() => setCount((c) => c - 1), []);
  const reset = useCallback(() => setCount(0), []);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        alignItems: "flex-start",
      }}
    >
      <h1>{APP_NAME}</h1>
      <p data-testid="count" style={{ fontSize: "3rem", margin: 0 }}>
        {count}
      </p>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={decrement}>
          −1
        </button>
        <button type="button" onClick={increment}>
          +1
        </button>
        <button type="button" onClick={reset}>
          reset
        </button>
      </div>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
