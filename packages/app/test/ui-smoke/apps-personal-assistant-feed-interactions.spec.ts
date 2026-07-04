/**
 * Playwright UI-smoke spec for the Apps Personal Assistant Feed Interactions
 * app flow using the real renderer fixture.
 */
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  assertReadyChecks,
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requestJson(route: Route): JsonRecord {
  const raw = route.request().postData();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function installFeedTuiRoutes(page: Page) {
  const state = {
    commands: [] as string[],
  };

  page.route(/\/api\/views\/feed\/interact(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = requestJson(route);
    const capability =
      typeof body.capability === "string" ? body.capability : "unknown";
    state.commands.push(capability);

    if (capability === "refresh-agent-status") {
      await fulfillJson(route, {
        ok: true,
        status: {
          id: "feed-agent-smoke",
          displayName: "Smoke Feed Agent",
          agentStatus: "scanning",
          autonomous: true,
        },
        dashboard: {
          summary: { ownerName: "Smoke Feed Desk" },
        },
        markets: {
          markets: [
            {
              id: "market-ui-smoke",
              title: "Will deterministic UI coverage pass?",
              yesPrice: 0.72,
              noPrice: 0.28,
            },
          ],
        },
      });
      return;
    }

    if (capability === "send-team-message") {
      await fulfillJson(route, {
        ok: true,
        message: "Terminal status check queued for Feed social channel.",
      });
      return;
    }

    await fulfillJson(route, {
      ok: true,
      path: "/feed",
      endpoints: [
        "/api/apps/feed/agent/status",
        "/api/apps/feed/team/dashboard",
        "/api/apps/feed/markets",
      ],
    });
  });

  return state;
}

test.beforeEach(async ({ page }) => {
  await hideContinuousChatOverlay(page);
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
  });
  await installDefaultAppRoutes(page);
});

test("Feed routes expose reachable GUI state and deterministic TUI commands", async ({
  page,
}) => {
  const feedTui = installFeedTuiRoutes(page);

  await openAppPath(page, "/feed");
  await assertReadyChecks(
    page,
    "feed gui no-run state",
    [
      { text: "Feed operator surface" },
      { text: "@elizaos/plugin-feed dynamic view smoke surface is ready." },
      { text: "Feed" },
    ],
    "any",
    90_000,
  );

  await page.goto("/feed/tui", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#root")).toBeVisible({ timeout: 90_000 });
  await assertReadyChecks(
    page,
    "feed tui",
    [
      { text: "elizaos://feed --type=tui" },
      { text: "refresh-agent-status" },
      { text: "send-team-message" },
    ],
    "all",
    90_000,
  );

  await page.getByRole("button", { name: "Run refresh-agent-status" }).click();
  await expect(
    page.locator('[data-terminal-output="ok"]').last(),
  ).toContainText("Smoke Feed Agent");
  await expect(
    page.locator('[data-terminal-output="ok"]').last(),
  ).toContainText("Will deterministic UI coverage pass?");

  await page.getByRole("button", { name: "Run send-team-message" }).click();
  await expect(
    page.locator('[data-terminal-output="ok"]').last(),
  ).toContainText("Terminal status check queued for Feed social channel.");
  await expect
    .poll(() => feedTui.commands)
    .toEqual(["refresh-agent-status", "send-team-message"]);
});
