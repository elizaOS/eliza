// Runtime bridge inventory for plugin-backed app pages. These views are not all
// shell-owned: some are registered in-process through registerAppShellPage,
// while Feed is served as a dynamic/spatial view. The common requirement is the
// same: chat/voice can address their controls through view-interact.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

interface AgentElement {
  id: string;
  role: string;
  label: string;
  status?: string;
  value?: unknown;
  fillable: boolean;
  clickable: boolean;
}

declare global {
  interface Window {
    __ELIZA_BRIDGE__?: {
      readonly viewInteract?: (
        viewId: string,
        viewType: string,
        capability: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }
}

const PLUGIN_VIEW_TARGETS: readonly {
  label: string;
  path: string;
  viewId: string;
  ready: { testId: string } | { text: string | RegExp };
  requiredIds: readonly string[];
}[] = [
  {
    label: "Wallet",
    path: "/wallet",
    viewId: "wallet.inventory",
    ready: { testId: "wallet-shell" },
    requiredIds: ["tab-tokens", "tab-defi", "account-rpc-settings"],
  },
  {
    label: "Orchestrator",
    path: "/orchestrator",
    viewId: "orchestrator",
    ready: { text: /Pause all/i },
    requiredIds: ["pause-all", "resume-all", "refresh"],
  },
  {
    label: "Feed",
    path: "/feed",
    viewId: "feed",
    ready: { text: /Spawn agent/i },
    requiredIds: ["spawn-agent"],
  },
];

async function waitForReady(
  page: Page,
  target: (typeof PLUGIN_VIEW_TARGETS)[number],
) {
  if ("testId" in target.ready) {
    await expect(page.getByTestId(target.ready.testId)).toBeVisible({
      timeout: 60_000,
    });
    return;
  }
  await expect(page.getByText(target.ready.text).first()).toBeVisible({
    timeout: 60_000,
  });
}

async function waitForAgentBridge(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => typeof window.__ELIZA_BRIDGE__?.viewInteract === "function",
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function interact(
  page: Page,
  viewId: string,
  capability: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return page.evaluate(
    async ({ viewId, capability, params }) => {
      const bridge = window.__ELIZA_BRIDGE__?.viewInteract;
      if (!bridge) throw new Error("view-interact bridge not installed");
      return bridge(viewId, "gui", capability, params);
    },
    { viewId, capability, params },
  );
}

async function listAgentElements(
  page: Page,
  viewId: string,
): Promise<AgentElement[]> {
  return (await interact(page, viewId, "list-elements")) as AgentElement[];
}

async function describeElement(
  page: Page,
  viewId: string,
  id: string,
): Promise<AgentElement | null> {
  return (await interact(page, viewId, "describe-element", {
    id,
  })) as AgentElement | null;
}

async function expectAgentIds(
  page: Page,
  viewId: string,
  expectedIds: readonly string[],
  label: string,
): Promise<void> {
  await expect
    .poll(
      async () => (await listAgentElements(page, viewId)).map(({ id }) => id),
      {
        message: `${label} exposes ${expectedIds.join(", ")} through the agent bridge`,
        timeout: 30_000,
      },
    )
    .toEqual(expect.arrayContaining([...expectedIds]));
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("plugin views expose concrete chat/voice-drivable controls through the agent bridge", async ({
  page,
}) => {
  for (const target of PLUGIN_VIEW_TARGETS) {
    await openAppPath(page, target.path);
    await waitForReady(page, target);
    await waitForAgentBridge(page);
    await expectAgentIds(page, target.viewId, target.requiredIds, target.label);
  }
});

test("registered app-shell plugin pages can be clicked through the bridge", async ({
  page,
}) => {
  await openAppPath(page, "/orchestrator");
  await expect(page.getByRole("button", { name: /Pause all/i })).toBeVisible({
    timeout: 60_000,
  });
  await waitForAgentBridge(page);
  const refreshClick = (await interact(page, "orchestrator", "agent-click", {
    id: "refresh",
  })) as { ok?: boolean };
  expect(refreshClick?.ok).toBe(true);

  await openAppPath(page, "/wallet");
  await expect(page.getByTestId("wallet-shell")).toBeVisible({
    timeout: 60_000,
  });
  const nftsClick = (await interact(page, "wallet.inventory", "agent-click", {
    id: "tab-nfts",
  })) as { ok?: boolean };
  expect(nftsClick?.ok).toBe(true);
  await expect
    .poll(
      async () =>
        (await describeElement(page, "wallet.inventory", "tab-nfts"))?.status,
      { timeout: 5_000 },
    )
    .toBe("active");
});
