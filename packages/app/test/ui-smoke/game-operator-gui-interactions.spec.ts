// @eliza-live-audit allow-route-fixtures
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type OperatorGameFixture = {
  appName: string;
  displayName: string;
  slug: string;
  viewerPath: string;
  surfaceTestId: string;
  suggestedPrompt: string;
  controlButton: string;
  controlAction: "pause" | "resume";
  operatorRoutePath?: string;
  hostOnly?: boolean;
};

const FIXTURES: OperatorGameFixture[] = [
  {
    appName: "@elizaos/plugin-2004scape",
    displayName: "2004scape",
    slug: "2004scape",
    viewerPath: "/api/apps/2004scape/viewer",
    surfaceTestId: "2004scape-live-operator-surface",
    suggestedPrompt: "Continue tutorial",
    controlButton: "Pause session",
    controlAction: "pause",
  },
  {
    appName: "@hyperscape/plugin-hyperscape",
    displayName: "Hyperscape",
    slug: "hyperscape",
    viewerPath: "/api/apps/hyperscape/viewer",
    surfaceTestId: "hyperscape-detail-operator-surface",
    suggestedPrompt: "look around",
    controlButton: "Pause autonomy",
    controlAction: "pause",
    hostOnly: true,
  },
  {
    appName: "@elizaos/plugin-scape",
    displayName: "'scape",
    slug: "scape",
    viewerPath: "/api/apps/scape/viewer",
    surfaceTestId: "scape-live-operator-surface",
    suggestedPrompt: "Walk to the Lumbridge cows and train attack.",
    controlButton: "Resume",
    controlAction: "resume",
  },
];

function nowIso(): string {
  return new Date("2026-04-24T00:00:00.000Z").toISOString();
}

function makeSession(fixture: OperatorGameFixture) {
  if (fixture.slug === "2004scape") {
    return {
      sessionId: "scape-2004-session",
      appName: fixture.appName,
      mode: "spectate-and-steer",
      status: "running",
      displayName: fixture.displayName,
      agentId: "agent-smoke",
      characterId: "CookAssistant",
      canSendCommands: true,
      controls: ["pause", "resume"],
      summary: "Training tutorial island survival loop.",
      goalLabel: "Complete the starter combat tutorial",
      suggestedPrompts: [
        fixture.suggestedPrompt,
        "Check inventory",
        "Walk to the nearest banker",
      ],
      telemetry: {
        autoPlay: true,
        botName: "CookAssistant",
        intent: "tutorial",
        tutorial: {
          active: true,
          prompt: "Talk to the survival expert.",
        },
        player: {
          name: "CookAssistant",
          worldX: 3218,
          worldZ: 3222,
          hp: 10,
          maxHp: 10,
        },
        combatStyle: {
          weaponName: "Bronze sword",
          activeStyle: "accurate",
        },
        nearbyNpcs: [
          {
            name: "Survival Expert",
            distance: 2,
            optionsWithIndex: [{ text: "Talk-to" }],
          },
        ],
        skills: [{ name: "Attack", level: 3 }],
        inventory: [{ name: "Bronze axe", amount: 1 }],
        recentActivity: [
          {
            action: "observe",
            detail: "Tutorial prompt updated.",
            ts: nowIso(),
          },
        ],
      },
    };
  }

  if (fixture.slug === "hyperscape") {
    return {
      sessionId: "hyperscape-session",
      appName: fixture.appName,
      mode: "spectate-and-steer",
      status: "running",
      displayName: fixture.displayName,
      agentId: "agent-smoke",
      characterId: "hyper-agent",
      canSendCommands: true,
      controls: ["pause", "resume"],
      summary: "Following a target through the host world.",
      goalLabel: "Track the guide avatar",
      suggestedPrompts: [
        fixture.suggestedPrompt,
        "follow target",
        "explain surroundings",
      ],
      followEntity: "guide-avatar",
      activity: [
        {
          id: "hyperscape-activity-1",
          type: "viewer",
          message: "Target guide-avatar is visible.",
          timestamp: nowIso(),
        },
      ],
      telemetry: {
        recentActivity: [
          {
            action: "follow",
            detail: "Guide target acquired.",
            ts: nowIso(),
          },
        ],
      },
    };
  }

  return {
    sessionId: "scape-session",
    appName: fixture.appName,
    mode: "spectate-and-steer",
    status: "paused",
    displayName: fixture.displayName,
    agentId: "agent-smoke",
    characterId: "LumbridgeRanger",
    canSendCommands: true,
    controls: ["pause", "resume"],
    summary: "Paused near Lumbridge while awaiting operator direction.",
    goalLabel: "Train attack on cows",
    suggestedPrompts: [
      fixture.suggestedPrompt,
      "Check inventory and food.",
      "Walk to the nearest bank.",
    ],
    activity: [
      {
        id: "scape-activity-1",
        type: "perception",
        message: "Cow and bones detected nearby.",
        severity: "info",
      },
    ],
    telemetry: {
      connectionStatus: "connected",
      pausedByOperator: true,
      operatorGoal: "Train attack on cows",
      activeGoal: {
        id: "goal-cows",
        title: "Train attack on cows",
        notes: "Stay near Lumbridge and eat if health drops.",
        status: "active",
        source: "operator",
        progress: 0.25,
        createdAt: Date.parse(nowIso()),
        updatedAt: Date.parse(nowIso()),
      },
      agent: {
        name: "LumbridgeRanger",
        combatLevel: 4,
        hp: 8,
        maxHp: 10,
        runEnergy: 91,
        inCombat: false,
        position: { x: 3225, z: 3265 },
        tick: 128,
      },
      journal: {
        sessionCount: 2,
        memoryCount: 4,
        recent: [
          {
            id: "memory-cows",
            kind: "goal",
            text: "Operator asked for cow combat training.",
            weight: 4,
            timestamp: Date.parse(nowIso()),
            position: { x: 3225, z: 3265 },
          },
        ],
      },
      nearby: {
        npcs: [
          {
            id: 1,
            name: "Cow",
            combatLevel: 2,
            hp: 6,
            position: { x: 3226, z: 3266 },
            distance: 1,
          },
        ],
        players: [],
        items: [{ itemId: 526, name: "Bones", count: 1, distance: 2 }],
      },
      skills: [{ id: 0, name: "Attack", level: 4, baseLevel: 4, xp: 320 }],
      inventory: [{ slot: 0, itemId: 315, name: "Shrimps", count: 3 }],
    },
  };
}

function makeRun(fixture: OperatorGameFixture) {
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
      postMessageAuth: fixture.slug === "2004scape",
      authMessage:
        fixture.slug === "2004scape"
          ? {
              type: "2004scape-auth",
              authToken: "bot-smoke",
              sessionToken: "session-smoke",
            }
          : fixture.slug === "hyperscape"
            ? { type: "hyperscape-auth", followEntity: "guide-avatar" }
            : null,
    },
    session,
    characterId: session.characterId,
    agentId: "agent-smoke",
    status: "running",
    summary: session.summary,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    lastHeartbeatAt: nowIso(),
    supportsBackground: true,
    supportsViewerDetach: true,
    chatAvailability: "available",
    controlAvailability: "available",
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
      control: { state: "healthy", message: null },
      message: null,
    },
  };
}

function makeApp(fixture: OperatorGameFixture) {
  return {
    name: fixture.appName,
    displayName: fixture.displayName,
    description: `${fixture.displayName} operator smoke app`,
    category: "game",
    launchType: "connect",
    launchUrl: `https://example.test/${fixture.slug}`,
    icon: null,
    heroImage: null,
    capabilities: ["commands", "telemetry", "controls"],
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
      features: ["commands", "telemetry", "suggestions", "controls"],
    },
  };
}

async function installOperatorGameRoutes(
  page: Page,
  fixture: OperatorGameFixture,
) {
  let run = makeRun(fixture);
  let launched = false;
  const app = makeApp(fixture);
  const messages: string[] = [];
  const controls: string[] = [];
  let viewerRequestCount = 0;

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
        message: "Operator message accepted.",
        disposition: "accepted",
        status: 200,
        run,
        session: run.session,
      }),
    });
  });

  await page.route("**/api/apps/runs/*/control", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { action?: string };
    controls.push(body.action ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        message: `Operator ${body.action ?? "control"} accepted.`,
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
      run = { ...run, viewerAttachment: "attached" };
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

  await page.context().route(`**${fixture.viewerPath}**`, async (route) => {
    viewerRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body><main data-testid="${fixture.slug}-viewer">${fixture.displayName}</main></body></html>`,
    });
  });

  return {
    controls,
    messages,
    viewerRequestCount: () => viewerRequestCount,
  };
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
});

for (const fixture of FIXTURES) {
  test(`${fixture.displayName} game GUI exercises exposed controls`, async ({
    page,
  }) => {
    const api = await installOperatorGameRoutes(page, fixture);

    await openAppPath(page, `/apps/${fixture.slug}/details`);
    await page
      .getByTestId("app-launch-panel")
      .getByRole("button", { name: "Launch" })
      .click();

    await expect(page.getByTestId("game-view-iframe")).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() => api.viewerRequestCount(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    if (fixture.hostOnly) {
      await expect(page.getByRole("button", { name: "Details" })).toBeVisible();
      await page.getByRole("button", { name: "Details" }).click();
      await expect(page.getByText("Connection: connected")).toBeVisible();
      await page.getByTestId("game-session-control").click();
      await expect.poll(() => api.controls.at(-1)).toBe(fixture.controlAction);
      return;
    }

    if (fixture.operatorRoutePath) {
      await page.evaluate((path) => {
        window.history.pushState(null, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, fixture.operatorRoutePath);
    }
    const surface = page.getByTestId(fixture.surfaceTestId);
    await expect(surface).toBeVisible({ timeout: 60_000 });
    await expect(surface).toContainText(fixture.displayName);

    await surface
      .getByRole("button", { name: fixture.suggestedPrompt })
      .click();
    await expect.poll(() => api.messages.at(-1)).toBe(fixture.suggestedPrompt);

    await surface.getByRole("button", { name: fixture.controlButton }).click();
    await expect.poll(() => api.controls.at(-1)).toBe(fixture.controlAction);
  });
}
