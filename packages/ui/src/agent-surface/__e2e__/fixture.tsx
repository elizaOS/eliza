/**
 * Self-contained browser fixture for the agent-surface e2e. Renders a small
 * "view" of agent-addressable controls inside an AgentSurfaceProvider and
 * exposes the capability bridge on `window.__agentSurface` so a Playwright
 * driver can act on it exactly like the floating pill would (list-elements,
 * agent-fill, agent-click, set-highlight) — in a real browser, no app server.
 */

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentElementOverlay } from "../AgentElementOverlay";
import { AgentSurfaceProvider } from "../AgentSurfaceContext";
import { handleAgentSurfaceCapability } from "../capabilities";
import { AgentButton, AgentInput, IconTag } from "../components";
import { getViewRegistry } from "../registry";
import { useAgentElement } from "../useAgentElement";

const VIEW = "e2e";

function StatusPill({ label, on }: { label: string; on: boolean }) {
  const { ref, agentProps } = useAgentElement<HTMLSpanElement>({
    id: `status-${label.toLowerCase()}`,
    role: "status",
    label: `${label} status`,
    status: on ? "active" : "inactive",
  });
  return (
    <span
      ref={ref}
      {...agentProps}
      className="rounded-full"
      style={{
        padding: "2px 10px",
        fontSize: 12,
        background: on ? "#1f7a3f" : "#333",
        color: "#fff",
      }}
    >
      {label}
    </span>
  );
}

function ViewBody() {
  const [name, setName] = useState("");
  const [count, setCount] = useState(0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>Demo view</h2>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <StatusPill label="Online" on />
        <IconTag label="finance" tone="accent" />
        <IconTag label="error" tone="danger" status="error" />
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>Name</span>
        <AgentInput
          agentId="name"
          agentLabel="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6 }}
        />
      </label>
      <output data-testid="name-mirror" style={{ fontSize: 13 }}>
        name={name || "(empty)"}
      </output>
      <div style={{ display: "flex", gap: 8 }}>
        <AgentButton
          agentId="increment"
          onClick={() => setCount((c) => c + 1)}
          style={{ padding: "6px 12px", borderRadius: 6 }}
        >
          Increment
        </AgentButton>
        <output data-testid="count-mirror" style={{ fontSize: 13 }}>
          count={count}
        </output>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    __agentSurface?: (
      capability: string,
      params?: Record<string, unknown>,
    ) => unknown;
  }
}

window.__agentSurface = (capability, params) => {
  const registry = getViewRegistry(VIEW, "gui");
  if (!registry) throw new Error("registry not mounted");
  return handleAgentSurfaceCapability(registry, capability, params);
};

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        color: "#eee",
        background: "#0d1117",
        padding: 28,
        minHeight: "100vh",
      }}
    >
      <AgentSurfaceProvider viewId={VIEW} viewType="gui">
        <ViewBody />
        <AgentElementOverlay />
      </AgentSurfaceProvider>
    </div>,
  );
}
