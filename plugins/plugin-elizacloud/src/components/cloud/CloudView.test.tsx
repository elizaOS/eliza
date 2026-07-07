// @vitest-environment jsdom
/**
 * CloudView state-machine suite (jsdom): loading / signed-out / error / ready
 * renders, the per-section designed degradation inside ready, and retry
 * recovery. Fetchers are injected through the component's seam — the
 * component's own state machine, card rendering, and settle logic run for
 * real.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloudViewFetchers } from "./CloudView.tsx";
import { CloudView } from "./CloudView.tsx";

const CONNECTED_STATUS = {
  connected: true,
  enabled: true,
  hasApiKey: true,
  userId: "user-1",
  organizationId: "org-1",
};

const CREDITS = {
  connected: true,
  balance: 12.34,
  low: false,
  critical: false,
  topUpUrl: "https://elizacloud.ai/dashboard/settings?tab=billing",
};

const AGENT = {
  agent_id: "agent-1",
  agent_name: "alpha",
  node_id: null,
  container_id: null,
  headscale_ip: null,
  bridge_url: null,
  web_ui_url: null,
  status: "running",
  agent_config: {},
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  containerUrl: "",
  webUiUrl: null,
  database_status: "healthy",
  error_message: null,
  last_heartbeat_at: null,
};

function fetchers(overrides: Partial<CloudViewFetchers> = {}): CloudViewFetchers {
  return {
    fetchStatus: async () => CONNECTED_STATUS,
    fetchCredits: async () => CREDITS,
    fetchAgents: async () => ({ success: true, data: [AGENT] }),
    fetchApiKeys: async () => ({
      keys: [
        { id: "k1", name: "ci", keyPrefix: "eliza_abc1", createdAt: null },
        { id: "k2", name: "dev", keyPrefix: "eliza_abc2", createdAt: null },
      ],
      manageUrl: "https://elizacloud.ai/dashboard/api-keys",
    }),
    fetchBillingSummary: async () => ({
      balance: 12.34,
      currency: "USD",
      hasPaymentMethod: true,
    }),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(seam: CloudViewFetchers) {
  await act(async () => {
    root.render(<CloudView fetchers={seam} />);
  });
  // Let the async account load settle.
  await act(async () => {
    await Promise.resolve();
  });
}

function testId(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("CloudView", () => {
  it("shows the loading state while the account load is in flight", async () => {
    const never = new Promise<typeof CONNECTED_STATUS>(() => {});
    await act(async () => {
      root.render(<CloudView fetchers={fetchers({ fetchStatus: () => never })} />);
    });
    expect(testId("cloud-loading")).not.toBeNull();
    expect(container.textContent).toContain("Loading your Eliza Cloud account");
  });

  it("renders the designed signed-out state with a connect CTA", async () => {
    await render(
      fetchers({ fetchStatus: async () => ({ connected: false, enabled: true }) }),
    );
    expect(testId("cloud-signed-out")).not.toBeNull();
    expect(container.textContent).toContain("Connect your Eliza Cloud account");
    expect(container.querySelector("button")?.textContent).toContain(
      "Connect in Settings",
    );
  });

  it("renders the error state and recovers on retry", async () => {
    let fail = true;
    await render(
      fetchers({
        fetchStatus: async () => {
          if (fail) throw new Error("cloud unreachable");
          return CONNECTED_STATUS;
        },
      }),
    );
    expect(testId("cloud-error")).not.toBeNull();
    expect(container.textContent).toContain("cloud unreachable");

    fail = false;
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(testId("cloud-ready")).not.toBeNull();
  });

  it("renders the ready state: balance, agents, key count, billing", async () => {
    await render(fetchers());
    expect(testId("cloud-ready")).not.toBeNull();
    expect(testId("cloud-credit-balance")?.textContent).toBe("$12.34");
    expect(testId("cloud-org-id")?.textContent).toBe("org-1");
    expect(testId("cloud-agent-list")?.textContent).toContain("alpha");
    expect(testId("cloud-agent-list")?.textContent).toContain("running");
    expect(testId("cloud-api-key-count")?.textContent).toBe("2 API keys");
    expect(container.textContent).toContain("Payment method on file.");
    expect(container.textContent).toContain("Top up");
  });

  it("renders the designed empty state when there are no hosted agents", async () => {
    await render(fetchers({ fetchAgents: async () => ({ success: true, data: [] }) }));
    expect(container.textContent).toContain("No hosted agents yet");
  });

  it("degrades a failing section to its unavailable note without faking empty", async () => {
    await render(
      fetchers({
        fetchAgents: async () => {
          throw new Error("agents endpoint down");
        },
      }),
    );
    // Still ready — credits render…
    expect(testId("cloud-credit-balance")?.textContent).toBe("$12.34");
    // …but the agents card is a designed unavailable note, not an empty list.
    expect(container.textContent).toContain("Agents are unavailable right now.");
    expect(container.textContent).not.toContain("No hosted agents yet");
  });

  it("explains the session-only key list instead of rendering a false zero", async () => {
    await render(
      fetchers({
        fetchApiKeys: async () => ({
          keys: null,
          manageUrl: "https://elizacloud.ai/dashboard/api-keys",
          reason: "session-required" as const,
        }),
      }),
    );
    expect(testId("cloud-api-key-count")).toBeNull();
    expect(container.textContent).toContain("signed-in session");
  });
});
