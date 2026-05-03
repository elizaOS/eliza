import { expect, test } from "@playwright/test";
import { authenticateBrowserContext } from "./fixtures/auth.fixture";

const REAL_AUTH_TIMEOUT_MS = 5 * 60_000;
const STEWARD_TOKEN = process.env.PLAYWRIGHT_STEWARD_TOKEN;
const STEWARD_REFRESH_TOKEN = process.env.PLAYWRIGHT_STEWARD_REFRESH_TOKEN;

test.describe("Authenticated dashboard session", () => {
  test("authenticated session reaches dashboard without auth 401s @auth-real", async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(REAL_AUTH_TIMEOUT_MS);

    const authFailures: Array<{ url: string; status: number }> = [];

    page.on("response", (response) => {
      const url = response.url();
      if (
        response.status() === 401 &&
        (url.includes("/api/v1/user") || url.includes("/api/credits/balance"))
      ) {
        authFailures.push({ url, status: response.status() });
      }
    });

    if (STEWARD_TOKEN) {
      await page.addInitScript(
        ({ token, refreshToken }) => {
          window.localStorage.setItem("steward_session_token", token);
          if (refreshToken) {
            window.localStorage.setItem("steward_refresh_token", refreshToken);
          }
          window.dispatchEvent(new CustomEvent("steward-token-sync"));
        },
        { token: STEWARD_TOKEN, refreshToken: STEWARD_REFRESH_TOKEN ?? null },
      );
    } else {
      await authenticateBrowserContext(request, page.context(), baseURL);
    }

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { name: "Infrastructure" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Instances" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Containers" })).toBeVisible();
    await expect(page.getByRole("link", { name: "My Agents" })).toBeVisible();
    expect(authFailures).toEqual([]);
  });
});
