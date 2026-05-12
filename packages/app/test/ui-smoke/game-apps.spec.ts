// @eliza-live-audit allow-route-fixtures
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type GameFixture = {
  appName: string;
  displayName: string;
  slug: string;
  viewerPath: string;
  surfaceTestId: string;
  commandChecks: Array<{ testId: string; content: string }>;
  chatInputTestId: string;
  chatSendTestId: string;
  chatContent: string;
};

const FIXTURES: GameFixture[] = [
  {
    appName: "@elizaos/app-defense-of-the-agents",
    displayName: "Defense of the Agents",
    slug: "defense-of-the-agents",
    viewerPath: "/api/apps/defense-of-the-agents/viewer",
    surfaceTestId: "defense-live-operator-surface",
    commandChecks: [
      { testId: "defense-command-lane-top", content: "Move to top lane" },
      { testId: "defense-command-recall", content: "Recall to base" },
      { testId: "defense-command-autoplay", content: "Auto-play OFF" },
    ],
    chatInputTestId: "defense-chat-input",
    chatSendTestId: "defense-chat-send",
    chatContent: "Reinforce mid after the next wave",
  },
  {
    appName: "@elizaos/app-clawville",
    displayName: "ClawVille",
    slug: "clawville",
    viewerPath: "/api/apps/clawville/viewer",
    surfaceTestId: "clawville-live-operator-surface",
    commandChecks: [
      {
        testId: "clawville-command-move-krusty",
        content: "Move to tool workshop",
      },
      {
        testId: "clawville-command-visit-nearest",
        content: "Visit the nearest building",
      },
      {
        testId: "clawville-command-ask-npc",
        content: "Ask the nearest NPC what to learn next",
      },
    ],
    chatInputTestId: "clawville-chat-input",
    chatSendTestId: "clawville-chat-send",
    chatContent: "Ask the nearest NPC about MCP tools",
  },
];

function nowIso(): string {
  return new Date("2026-04-24T00:00:00.000Z").toISOString();
}

function makeSession(fixture: GameFixture) {
  if (fixture.slug === "defense-of-the-agents") {
    return {
      sessionId: "defense-session",
      appName: fixture.appName,
      mode: "spectate-and-steer",
      status: "running",
      displayName: fixture.displayName,
      agentId: "agent-smoke",
      canSendCommands: true,
      controls: [],
      summary: "Mage level 3 in mid lane, 80/100 HP.",
      goalLabel: "Holding mid lane",
      suggestedPrompts: [
        "Move to top lane",
        "Recall to base",
        "Review strategy",
      ],
      telemetry: {
        heroClass: "mage",
        heroLane: "mid",
        heroLevel: 3,
        heroHp: 80,
        heroMaxHp: 100,
        autoPlay: true,
      },
    };
  }

  return {
    sessionId: "clawville-session",
    appName: fixture.appName,
    mode: "spectate-and-steer",
    status: "running",
    displayName: fixture.displayName,
    agentId: "eliza:agent-smoke",
    canSendCommands: true,
    controls: [],
    summary:
      "Eliza Agent (returning) | session #2 | 9x9x...test | 2 skills learned",
    goalLabel: "Nearest: Krusty Krab",
    suggestedPrompts: [
      "Move to Krusty Krab",
      "Visit the nearest building",
      "Ask the nearest NPC what to learn next",
    ],
    telemetry: {
      walletAddress: "9x9x9x9x9x9x9x9x9x9xtest",
      knowledgeCount: 2,
      totalSessions: 2,
      nearestBuildingId: "tool-workshop",
      nearestBuildingLabel: "Krusty Krab",
    },
  };
}

function makeRun(fixture: GameFixture) {
  const session = makeSession(fixture);
  return {
    runId: `${fixture.slug}-run`,
    appName: fixture.appName,
    displayName: fixture.displayName,
    pluginName: fixture.appName,
    launchType: "connect",
    launchUrl: `https://example.test/${fixture.slug}`,
    viewer: {
      url: fixture.viewerPath,
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
    session,
    characterId: null,
    agentId: "agent-smoke",
    status: "running",
    summary: session.summary,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    lastHeartbeatAt: nowIso(),
    supportsBackground: true,
    supportsViewerDetach: true,
    chatAvailability: "available",
    controlAvailability: "unavailable",
    viewerAttachment: "attached",
    recentEvents: [],
    awaySummary: null,
    health: { state: "healthy", message: null },
    healthDetails: {
      checkedAt: nowIso(),
      auth: { state: "healthy", message: null },
      runtime: { state: "healthy", message: null },
      viewer: { state: "healthy", message: null },
      chat: { state: "healthy", message: null },
      control: { state: "unknown", message: null },
      message: null,
    },
  };
}

function makeApp(fixture: GameFixture) {
  return {
    name: fixture.appName,
    displayName: fixture.displayName,
    description: `${fixture.displayName} smoke app`,
    category: "game",
    launchType: "connect",
    launchUrl: `https://example.test/${fixture.slug}`,
    icon: null,
    heroImage: null,
    capabilities: ["commands", "telemetry"],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: true, v1: true, v2: true },
    npm: {
      package: fixture.appName,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
    viewer: {
      url: fixture.viewerPath,
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    },
    session: {
      mode: "spectate-and-steer",
      features: ["commands", "telemetry", "suggestions"],
    },
  };
}

async function installGameRoutes(page: Page, fixture: GameFixture) {
  let run = makeRun(fixture);
  let launched = false;
  const app = makeApp(fixture);
  const messages: string[] = [];

  await installDefaultAppRoutes(page);

  await page.route("**/api/apps", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([app]),
    });
  });

  await page.route("**/api/catalog/apps", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([app]),
    });
  });

  await page.route("**/api/apps/launch", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    run = makeRun(fixture);
    launched = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        pluginInstalled: true,
        needsRestart: false,
        displayName: fixture.displayName,
        launchType: "connect",
        launchUrl: run.launchUrl,
        viewer: run.viewer,
        session: run.session,
        run,
        diagnostics: [],
      }),
    });
  });

  await page.route("**/api/apps/runs/*/message", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { content?: string };
    messages.push(body.content ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        message: "Command accepted.",
        disposition: "accepted",
        status: 200,
        run,
        session: run.session,
      }),
    });
  });

  await page.route("**/api/apps/runs/*/heartbeat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, message: "ok", run }),
    });
  });

  await page.route("**/api/apps/runs", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(launched ? [run] : []),
    });
  });

  await page.route("**/api/apps/runs/*", async (route) => {
    const method = route.request().method();
    if (method === "PATCH") {
      run = {
        ...run,
        viewerAttachment: "attached",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          message: `${fixture.displayName} attached.`,
          run,
        }),
      });
      return;
    }
    if (method !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(run),
    });
  });

  await page.route(`**${fixture.viewerPath}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body><main data-testid="${fixture.slug}-viewer">${fixture.displayName}</main></body></html>`,
    });
  });

  return {
    messages,
  };
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
});

for (const fixture of FIXTURES) {
  test(`${fixture.displayName} route exposes playable controls and chat`, async ({
    page,
  }) => {
    const api = await installGameRoutes(page, fixture);

    await openAppPath(page, `/apps/${fixture.slug}`);
    const launchButton = page
      .getByTestId("app-launch-panel")
      .getByRole("button", { name: "Launch" });
    await expect(launchButton).toBeVisible({ timeout: 60_000 });
    await expect(launchButton).toHaveAttribute(
      "title",
      `Launch ${fixture.displayName}`,
    );
    await launchButton.click();

    await expect(page.getByTestId("game-view-iframe")).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page
        .frameLocator('[data-testid="game-view-iframe"]')
        .getByTestId(`${fixture.slug}-viewer`),
    ).toBeVisible();
    await expect(page.getByTestId(fixture.surfaceTestId)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Apps chat")).toHaveCount(0);

    for (const check of fixture.commandChecks) {
      const commandButton = page.getByTestId(check.testId);
      await commandButton.click();
      await expect.poll(() => api.messages.at(-1)).toBe(check.content);
      await expect(commandButton).toBeEnabled();
    }

    await page.getByTestId(fixture.chatInputTestId).fill(fixture.chatContent);
    await expect(page.getByTestId(fixture.chatSendTestId)).toBeEnabled();
    await page.getByTestId(fixture.chatSendTestId).click();
    await expect.poll(() => api.messages.at(-1)).toBe(fixture.chatContent);
  });
}
