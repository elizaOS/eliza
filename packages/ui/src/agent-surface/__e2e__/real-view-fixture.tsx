/**
 * Real-plugin-view target for the agent-surface e2e. Unlike fixture.tsx (which
 * declares its own synthetic controls), this mounts REAL components from
 * `@elizaos/plugin-task-coordinator` — `TaskCard`, `BackChip`, `TaskSearchInput`
 * — inside the host `AgentSurfaceProvider`. Those components call the real
 * `useAgentElement` from `@elizaos/ui/agent-surface`, so the host registry
 * discovers the plugin view's controls exactly the way DynamicViewLoader does in
 * the app. The Playwright driver then exercises the capability bridge against
 * real plugin source: list-elements → agent-click → agent-fill → state change.
 *
 * Hermetic because TaskCardList is pure presentation (no data fetch, no API
 * client): its only deps are `@elizaos/ui/agent-surface`, `lucide-react`, and
 * `react`, all of which esbuild bundles from local source alongside the host.
 */

import {
  BackChip,
  TaskCard,
  TaskSearchInput,
} from "../../../../../plugins/plugin-task-coordinator/src/TaskCardList";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentElementOverlay } from "../AgentElementOverlay";
import { AgentSurfaceProvider } from "../AgentSurfaceContext";
import { handleAgentSurfaceCapability } from "../capabilities";
import { getViewRegistry } from "../registry";
import { useAgentElement } from "../useAgentElement";

const VIEW = "orchestrator";
const t = (key: string) => key;

function ViewBody() {
  const [opened, setOpened] = useState("(none)");
  const [back, setBack] = useState(0);
  const [query, setQuery] = useState("");

  // Wire the real TaskSearchInput as a fillable agent element, exactly as the
  // task-coordinator landing does (it threads `agentProps` into the input).
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "task-search",
    role: "text-input",
    label: "Search tasks",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <TaskSearchInput
        value={query}
        onChange={setQuery}
        placeholder="Search tasks"
        inputRef={ref}
        agentProps={agentProps}
        testId="search-input"
      />
      <output data-testid="query-mirror" style={{ fontSize: 13 }}>
        query={query || "(empty)"}
      </output>

      <TaskCard
        id="abc"
        title="Ship the audit"
        subtitle="agent-reachable"
        status="open"
        chips={null}
        onOpen={(id) => setOpened(id)}
        t={t}
      />
      <output data-testid="opened-mirror" style={{ fontSize: 13 }}>
        opened={opened}
      </output>

      <BackChip
        label="Back"
        onClick={() => setBack((b) => b + 1)}
        testId="back-chip"
      />
      <output data-testid="back-mirror" style={{ fontSize: 13 }}>
        back={back}
      </output>
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
