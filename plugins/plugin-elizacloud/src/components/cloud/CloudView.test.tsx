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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudViewFetchers, CloudViewInteractions } from "./CloudView.tsx";
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
  topUpUrl: "https://cloud.eliza.app/cloud/billing",
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

function fetchers(
  overrides: Partial<CloudViewFetchers> = {},
): CloudViewFetchers {
  return {
    fetchStatus: async () => CONNECTED_STATUS,
    fetchCredits: async () => CREDITS,
    fetchAgents: async () => ({ success: true, data: [AGENT] }),
    fetchApiKeys: async () => ({
      keys: [
        { id: "k1", name: "ci", keyPrefix: "eliza_abc1", createdAt: null },
        { id: "k2", name: "dev", keyPrefix: "eliza_abc2", createdAt: null },
      ],
      manageUrl: "https://cloud.eliza.app/cloud/api-keys",
    }),
    fetchBillingSummary: async () => ({
      balance: 12.34,
      currency: "USD",
      hasPaymentMethod: true,
    }),
    ...overrides,
  };
}

function interactions(
  overrides: Partial<CloudViewInteractions> = {},
): CloudViewInteractions {
  return {
    navigateInternal: vi.fn(),
    openExternal: vi.fn(async () => true),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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

async function render(
  seam: CloudViewFetchers,
  interactionSeam: CloudViewInteractions = interactions(),
) {
  await act(async () => {
    root.render(<CloudView fetchers={seam} interactions={interactionSeam} />);
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
      root.render(
        <CloudView fetchers={fetchers({ fetchStatus: () => never })} />,
      );
    });
    expect(testId("cloud-loading")).not.toBeNull();
    expect(container.textContent).toContain("Loading your Eliza Cloud account");
  });

  it("renders the designed signed-out state with a connect CTA", async () => {
    const interactionSeam = interactions();
    await render(
      fetchers({
        fetchStatus: async () => ({ connected: false, enabled: true }),
      }),
      interactionSeam,
    );
    expect(testId("cloud-signed-out")).not.toBeNull();
    expect(container.textContent).toContain("Connect to view credits");
    expect(container.textContent).not.toContain("Connected");
    expect(container.querySelector("button")?.textContent).toContain(
      "Connect in Settings",
    );
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(interactionSeam.navigateInternal).toHaveBeenCalledWith("/settings");
  });

  it("shows a visible failure when internal navigation is denied", async () => {
    await render(
      fetchers({
        fetchStatus: async () => ({ connected: false, enabled: true }),
      }),
      interactions({
        navigateInternal: () => {
          throw new Error("scope denied");
        },
      }),
    );
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Navigation is unavailable",
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
    expect(container.textContent).toContain("Connected");
    expect(testId("cloud-agent-list")?.textContent).toContain("alpha");
    expect(testId("cloud-agent-list")?.textContent).toContain("running");
    expect(testId("cloud-api-key-count")?.textContent).toBe("2 API keys");
    expect(container.textContent).toContain("Payment method on file.");
    expect(container.textContent).toContain("Top up");
  });

  it("opens server-provided links only through the host interaction boundary", async () => {
    const openExternal = vi.fn(async () => true);
    await render(fetchers(), interactions({ openExternal }));
    const topUp = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Top up",
    );
    const manage = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Manage",
    );
    await act(async () => {
      topUp?.click();
      manage?.click();
      await Promise.resolve();
    });
    expect(openExternal).toHaveBeenCalledWith(CREDITS.topUpUrl);
    expect(openExternal).toHaveBeenCalledWith(
      "https://cloud.eliza.app/cloud/api-keys",
    );
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
  });

  it.each([
    ["rejected", async () => false],
    ["failed", async () => Promise.reject(new Error("browser unavailable"))],
  ])(
    "shows a visible failure when an external URL is %s",
    async (_name, open) => {
      await render(fetchers(), interactions({ openExternal: open }));
      const topUp = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Top up",
      );
      await act(async () => {
        topUp?.click();
        await Promise.resolve();
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be opened safely",
      );
    },
  );

  it("renders the designed empty state when there are no hosted agents", async () => {
    await render(
      fetchers({ fetchAgents: async () => ({ success: true, data: [] }) }),
    );
    expect(container.textContent).toContain("No hosted agents.");
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
    expect(container.textContent).toContain(
      "Agents are unavailable right now.",
    );
    expect(container.textContent).not.toContain("No hosted agents yet");
  });

  it("explains the session-only key list instead of rendering a false zero", async () => {
    await render(
      fetchers({
        fetchApiKeys: async () => ({
          keys: null,
          manageUrl: "https://cloud.eliza.app/cloud/api-keys",
          reason: "session-required" as const,
        }),
      }),
    );
    expect(testId("cloud-api-key-count")).toBeNull();
    expect(container.textContent).toContain(
      "Open the console to view API keys",
    );
  });
});
