import type { Locator, Page } from "@playwright/test";
import { authenticateBrowserContext, expect, test } from "../fixtures/auth.fixture";

async function waitForFirstVisible(locators: Locator[], timeout = 10_000): Promise<void> {
  await Promise.any(
    locators.map(async (locator) => {
      await locator.waitFor({ state: "visible", timeout });
    }),
  );
}

function json(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

async function installAgentDashboardFixtures(page: Page): Promise<void> {
  await page.route("**/api/v1/eliza/agents", async (route) => {
    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route("**/api/credits/balance**", async (route) => {
    await route.fulfill(json({ balance: 100 }));
  });
}

async function expectInstancesPageContent(page: Page): Promise<void> {
  await expect(page.getByRole("main").getByRole("heading", { name: "Instances" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "New Agent" })).toBeVisible({
    timeout: 15_000,
  });

  await waitForFirstVisible(
    [
      page.getByPlaceholder("Search agents…"),
      page.getByText("No agents yet"),
      page.getByRole("columnheader", { name: /agent/i }),
      page.getByRole("link", { name: /Unnamed Agent/i }),
    ],
    15_000,
  );
}

test.describe("Eliza agent lifecycle", () => {
  test.beforeEach(async ({ page, request, baseURL }) => {
    await authenticateBrowserContext(request, page.context(), baseURL);
    await installAgentDashboardFixtures(page);
  });

  test("instances dashboard renders an authenticated Agent session", async ({ page, baseURL }) => {
    const baseUrl = baseURL ?? "http://localhost:3000";
    const response = await page.goto(`${baseUrl}/dashboard/agents`);
    expect(response?.status()).toBe(200);
    expect(page.url()).toBe(`${baseUrl}/dashboard/agents`);

    await expectInstancesPageContent(page);
  });

  test("authenticated dashboard navigation stays inside Agent and agent surfaces", async ({
    page,
    baseURL,
  }) => {
    const baseUrl = baseURL ?? "http://localhost:3000";
    const agentResponse = await page.goto(`${baseUrl}/dashboard/agents`);
    expect(agentResponse?.status()).toBe(200);
    await expectInstancesPageContent(page);

    const agentsResponse = await page.goto(`${baseUrl}/dashboard/my-agents`);
    expect(agentsResponse?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: /My Agents/i })).toBeVisible();
    expect(page.url()).toBe(`${baseUrl}/dashboard/my-agents`);

    const returnResponse = await page.goto(`${baseUrl}/dashboard/agents`);
    expect(returnResponse?.status()).toBe(200);
    await expectInstancesPageContent(page);
  });

  test("Eliza agent detail route fails gracefully for unknown agents", async ({
    page,
    baseURL,
  }) => {
    const baseUrl = baseURL ?? "http://localhost:3000";
    const response = await page.goto(
      `${baseUrl}/dashboard/agents/00000000-0000-4000-8000-000000000000`,
    );

    expect(response?.status(), `unexpected status for ${page.url()}`).not.toBe(500);
    expect(page.url()).not.toContain("/login");
  });
});
