// Browser and Skills are route-backed app views rather than VIEWS registry ids.
// This spec proves their controls are still chat/voice-drivable through the
// same view-interact bridge used by agent responses: list-elements, agent-fill,
// and agent-click mutate the live UI instead of only direct DOM clicks working.

import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

interface AgentElement {
  id: string;
  role: string;
  label: string;
  value?: unknown;
  fillable: boolean;
  clickable: boolean;
}

type BrowserWorkspaceSmokeSnapshot = {
  tabs: { id: string }[];
};

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

function isBrowserWorkspaceSmokeSnapshot(
  value: unknown,
): value is BrowserWorkspaceSmokeSnapshot {
  if (!value || typeof value !== "object") return false;
  const tabs = (value as { tabs?: unknown }).tabs;
  return (
    Array.isArray(tabs) &&
    tabs.every(
      (tab) =>
        Boolean(tab) &&
        typeof tab === "object" &&
        typeof (tab as { id?: unknown }).id === "string",
    )
  );
}

async function resetBrowserWorkspaceTabs(
  request: APIRequestContext,
): Promise<void> {
  const response = await request.get("/api/browser-workspace");
  expect(response.ok()).toBe(true);
  const snapshot: unknown = await response.json();
  expect(isBrowserWorkspaceSmokeSnapshot(snapshot)).toBe(true);
  if (!isBrowserWorkspaceSmokeSnapshot(snapshot)) return;

  for (const tab of snapshot.tabs) {
    const closeResponse = await request.delete(
      `/api/browser-workspace/tabs/${encodeURIComponent(tab.id)}`,
    );
    expect(closeResponse.ok()).toBe(true);
  }
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
  viewId: "browser" | "skills",
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

async function describeElement(
  page: Page,
  viewId: "browser" | "skills",
  id: string,
): Promise<AgentElement | null> {
  return (await interact(page, viewId, "describe-element", {
    id,
  })) as AgentElement | null;
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("browser route is chat/voice-drivable through the agent bridge", async ({
  page,
  request,
}) => {
  await resetBrowserWorkspaceTabs(request);
  await openAppPath(page, "/browser");
  await expect(page.getByTestId("browser-workspace-view")).toBeVisible({
    timeout: 60_000,
  });
  await waitForAgentBridge(page);

  const elements = (await interact(
    page,
    "browser",
    "list-elements",
  )) as AgentElement[];
  expect(
    elements.map((element) => element.id),
    "browser agent bridge exposes navigation controls",
  ).toEqual(expect.arrayContaining(["address-input", "new-tab", "go"]));

  const fill = (await interact(page, "browser", "agent-fill", {
    id: "address-input",
    value: "example.com",
  })) as { ok?: boolean };
  expect(fill?.ok).toBe(true);
  await expect
    .poll(
      async () =>
        (await describeElement(page, "browser", "address-input"))?.value,
      { timeout: 5_000 },
    )
    .toBe("example.com");

  const click = (await interact(page, "browser", "agent-click", {
    id: "new-tab",
  })) as { ok?: boolean };
  expect(click?.ok).toBe(true);

  const browserWorkspaceView = page.getByTestId("browser-workspace-view");
  await expect(
    browserWorkspaceView.locator('[role="tab"][title="https://example.com/"]'),
  ).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("browser-workspace-address-input")).toHaveValue(
    "https://example.com/",
  );
});

test("skills route is chat/voice-drivable through the agent bridge", async ({
  page,
}) => {
  await openAppPath(page, "/apps/skills");
  await expect(page.getByTestId("skills-shell")).toBeVisible({
    timeout: 60_000,
  });
  await waitForAgentBridge(page);

  const elements = (await interact(
    page,
    "skills",
    "list-elements",
  )) as AgentElement[];
  expect(
    elements.map((element) => element.id),
    "skills agent bridge exposes create controls",
  ).toEqual(expect.arrayContaining(["new-skill", "install-skill"]));

  const openCreate = (await interact(page, "skills", "agent-click", {
    id: "new-skill",
  })) as { ok?: boolean };
  expect(openCreate?.ok).toBe(true);
  await expect(
    page.getByRole("button", { name: /create skill/i }).first(),
  ).toBeVisible({ timeout: 10_000 });

  const nameFill = (await interact(page, "skills", "agent-fill", {
    id: "create-skill-name",
    value: "Bridge Skill",
  })) as { ok?: boolean };
  const descriptionFill = (await interact(page, "skills", "agent-fill", {
    id: "create-skill-description",
    value: "Created through the agent view bridge",
  })) as { ok?: boolean };
  expect(nameFill?.ok).toBe(true);
  expect(descriptionFill?.ok).toBe(true);
  await expect
    .poll(
      async () =>
        (await describeElement(page, "skills", "create-skill-name"))?.value,
      { timeout: 5_000 },
    )
    .toBe("Bridge Skill");
  await expect
    .poll(
      async () =>
        (await describeElement(page, "skills", "create-skill-description"))
          ?.value,
      { timeout: 5_000 },
    )
    .toBe("Created through the agent view bridge");
});
