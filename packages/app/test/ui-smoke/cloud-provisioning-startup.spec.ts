import { expect, type Page, type Route, test } from "@playwright/test";
import { installDefaultAppRoutes, openAppPath } from "./helpers";

type ViewportCase = {
  name: string;
  width: number;
  height: number;
};

const VIEWPORTS: ViewportCase[] = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "wide-web", width: 1440, height: 900 },
];

function apiBaseFromTest(baseURL: string | undefined): string {
  expect(baseURL, "Playwright baseURL must be configured").toBeTruthy();
  return (baseURL ?? "").replace(/\/$/, "");
}

async function fulfillJson(
  route: Route,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function clickIfVisible(locator: ReturnType<Page["getByRole"]>) {
  const visible = await locator
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
  if (visible) {
    await locator.click();
  }
}

for (const viewport of VIEWPORTS) {
  test(`cloud provisioning reaches chat from startup on ${viewport.name}`, async ({
    page,
    baseURL,
  }) => {
    const apiBase = apiBaseFromTest(baseURL);
    let provisionRequests = 0;
    let jobPollRequests = 0;
    let agentDetailRequests = 0;

    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    await installDefaultAppRoutes(page);

    await page.route("**/api/auth/status", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        required: false,
        authenticated: true,
        loginRequired: false,
        localAccess: true,
        passwordConfigured: false,
        pairingEnabled: false,
        expiresAt: null,
      });
    });

    await page.route("**/api/onboarding/status", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        complete: false,
        cloudProvisioned: false,
      });
    });

    await page.route("**/api/cloud/status", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        connected: true,
        enabled: true,
        cloudVoiceProxyAvailable: true,
        hasApiKey: true,
        userId: "cloud-provisioning-smoke-user",
      });
    });

    await page.route("**/api/cloud/credits", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        balance: 100,
        low: false,
        critical: false,
        authRejected: false,
      });
    });

    await page.route("**/api/cloud/compat/agents", async (route) => {
      const request = route.request();
      if (request.method() !== "GET") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, 200, {
        success: true,
        data: [
          {
            agent_id: "agent-1",
            agent_name: "My Agent",
            status: "stopped",
            bridge_url: null,
            web_ui_url: null,
            containerUrl: "",
            webUiUrl: null,
            database_status: "ready",
            error_message: null,
            agent_config: {},
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            last_heartbeat_at: null,
          },
        ],
      });
    });

    await page.route(
      "**/api/cloud/v1/eliza/agents/agent-1/provision",
      async (route) => {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }
        provisionRequests += 1;
        await fulfillJson(route, 202, {
          success: true,
          data: {
            jobId: "job-1",
            agentId: "agent-1",
            status: "pending",
          },
          polling: {
            endpoint: "/api/cloud/compat/jobs/job-1",
            intervalMs: 5000,
            expectedDurationMs: 90000,
          },
        });
      },
    );

    await page.route("**/api/cloud/compat/jobs/job-1", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      jobPollRequests += 1;
      await fulfillJson(route, 200, {
        success: true,
        data: {
          id: "job-1",
          jobId: "job-1",
          type: "agent_provision",
          status: "completed",
          data: {},
          result: {
            agentId: "agent-1",
            status: "running",
            bridgeUrl: apiBase,
          },
          error: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
          retryCount: 0,
          name: "agent_provision",
          state: "completed",
          created_on: "2026-01-01T00:00:00.000Z",
          completed_on: "2026-01-01T00:00:02.000Z",
        },
      });
    });

    await page.route("**/api/cloud/compat/agents/agent-1", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      agentDetailRequests += 1;
      await fulfillJson(route, 200, {
        success: true,
        data: {
          agent_id: "agent-1",
          agent_name: "My Agent",
          status: "running",
          bridge_url: apiBase,
          web_ui_url: null,
          containerUrl: "",
          webUiUrl: null,
          database_status: "ready",
          error_message: null,
          agent_config: {},
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:02.000Z",
          last_heartbeat_at: "2026-01-01T00:00:02.000Z",
        },
      });
    });

    await page.route(
      "**/api/cloud/compat/agents/agent-1/launch",
      async (route) => {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }
        await fulfillJson(route, 200, {
          success: true,
          data: {
            agentId: "agent-1",
            agentName: "My Agent",
            appUrl:
              "https://app.elizacloud.ai/?cloudLaunchSession=launch-1&cloudLaunchBase=https%3A%2F%2Fapi.elizacloud.ai",
            launchSessionId: "launch-1",
            issuedAt: "2026-01-01T00:00:02.000Z",
            connection: {
              apiBase,
              token: "agent-token",
            },
          },
        });
      },
    );

    await openAppPath(page, "/chat");
    await page.getByRole("button", { name: "Get started" }).click();
    await clickIfVisible(
      page.getByRole("button", { name: /sign in with eliza cloud/i }),
    );

    await expect.poll(() => provisionRequests).toBe(1);
    await expect.poll(() => jobPollRequests).toBeGreaterThan(0);
    await expect.poll(() => agentDetailRequests).toBeGreaterThan(0);
    await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("elizaos:active-server");
          return raw ? JSON.parse(raw) : null;
        }),
      )
      .toMatchObject({
        id: "cloud:agent-1",
        kind: "cloud",
        label: "My Agent",
        apiBase,
      });

    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("eliza:mobile-runtime-mode")),
      )
      .toBe("cloud");
  });
}
