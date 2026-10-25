/**
 * Teardown-navigation target for the agent-surface e2e (#20728). Reproduces the
 * Settings → Models & Providers crash: an instrumented section is mounted inside
 * an `AgentSurfaceProvider` alongside the live `AgentElementOverlay`
 * (`useSyncExternalStore` subscriber), highlight is switched on so the overlay is
 * actively subscribed, then the whole provider subtree is unmounted the way real
 * in-app navigation swaps sections. Before the fix, a descendant `useAgentElement`
 * unmount cleanup bumped the registry during React's deleted-tree passive phase,
 * forcing a re-render on the overlay committed for deletion (React #185 /
 * "Maximum update depth exceeded"). The driver asserts NO page/console errors
 * across repeated section transitions.
 *
 * The provider is `key`ed by section id so switching sections fully unmounts the
 * previous provider subtree — matching DynamicViewLoader's per-view remount.
 */

import { type ReactElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentElementOverlay } from "../AgentElementOverlay";
import { AgentSurfaceProvider } from "../AgentSurfaceContext";
import { handleAgentSurfaceCapability } from "../capabilities";
import { AgentButton, AgentInput } from "../components";
import { getViewRegistry } from "../registry";
import { useAgentElement } from "../useAgentElement";

declare global {
  interface Window {
    __navigate?: (section: string) => void;
    __agentSurface?: (
      capability: string,
      params?: Record<string, unknown>,
    ) => unknown;
  }
}

/** One provider row instrumented as an agent element (many of these mount in the
 *  real Models & Providers view). */
function ProviderRow({ index }: { index: number }) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: `provider-key-${index}`,
    role: "text-input",
    label: `Provider ${index} key`,
    sensitive: true,
  });
  return (
    <input
      ref={ref}
      {...agentProps}
      type="password"
      placeholder="sk-…"
      style={{ padding: "4px 8px", borderRadius: 6 }}
    />
  );
}

// The real section registers dozens of controls; a single teardown then fires
// dozens of bump()s. Each synchronously forces a re-render on the still-
// subscribed overlay, and >50 nested forced re-renders during one deleted-tree
// passive commit is what trips React's "Maximum update depth" guard (#20728).
const PROVIDER_ROW_COUNT = 60;

/** A settings-style section whose controls register with the agent surface. */
function ModelsSection() {
  const [provider, setProvider] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>Models &amp; Providers</h2>
      <AgentInput
        agentId="provider-name"
        agentLabel="Provider name"
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
        style={{ padding: "6px 10px", borderRadius: 6 }}
      />
      <input
        data-agent-id="consumer-key"
        type="password"
        placeholder="sk-…"
        style={{ padding: "6px 10px", borderRadius: 6 }}
      />
      {Array.from({ length: PROVIDER_ROW_COUNT }, (_, i) => (
        <ProviderRow key={i} index={i} />
      ))}
      <AgentButton agentId="save-models" style={{ padding: "6px 12px" }}>
        Save
      </AgentButton>
    </div>
  );
}

function GeneralSection() {
  return (
    <div>
      <h2 style={{ margin: 0, fontSize: 18 }}>General</h2>
      <AgentButton agentId="save-general" style={{ padding: "6px 12px" }}>
        Save
      </AgentButton>
    </div>
  );
}

const SECTIONS: Record<string, () => ReactElement> = {
  models: ModelsSection,
  general: GeneralSection,
};

/** Enables the highlight overlay for whichever section is mounted, so the
 *  `useSyncExternalStore` subscriber is live exactly when the section unmounts. */
function HighlightOnMount({ section }: { section: string }) {
  useEffect(() => {
    const registry = getViewRegistry(section, "gui");
    registry?.setHighlight(true);
  }, [section]);
  return null;
}

function App() {
  const [section, setSection] = useState("models");
  const Section = SECTIONS[section] ?? GeneralSection;

  useEffect(() => {
    window.__navigate = (next) => setSection(next);
    window.__agentSurface = (capability, params) => {
      const registry = getViewRegistry(section, "gui");
      if (!registry) throw new Error("registry not mounted");
      return handleAgentSurfaceCapability(registry, capability, params);
    };
    return () => {
      window.__navigate = undefined;
      window.__agentSurface = undefined;
    };
  }, [section]);

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        color: "#eee",
        background: "#0d1117",
        padding: 28,
        minHeight: "100dvh",
      }}
    >
      <div data-testid="active-section">section={section}</div>
      {/* Keyed by section so switching sections fully remounts the provider
          subtree — the real per-view teardown DynamicViewLoader performs. */}
      <AgentSurfaceProvider key={section} viewId={section} viewType="gui">
        <Section />
        <AgentElementOverlay />
        <HighlightOnMount section={section} />
      </AgentSurfaceProvider>
    </div>
  );
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(<App />);
}
