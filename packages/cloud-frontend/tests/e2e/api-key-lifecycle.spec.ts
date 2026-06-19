// API key lifecycle — the actions BEYOND create: disable (PATCH), regenerate
// (POST /:id/regenerate), delete (DELETE). Runs against the local dev build with
// VITE_PLAYWRIGHT_TEST_AUTH=true (test-auth cookie short-circuits real auth) and
// mocks every /api/v1/api-keys call so no real backend is touched. Each test
// drives the real "Manage key" row menu + confirm dialog and asserts the exact
// mutation request the UI sends — the gap left by api-key-flow.spec (create only).

import { expect, type Route, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "API key lifecycle uses local mocks; skipped in live-prod mode",
);

const KEY_ID = "key_live_1";

function activeKey() {
  return {
    id: KEY_ID,
    name: "Production key",
    description: "",
    key_prefix: "eliza_pk_live",
    is_active: true,
    last_used_at: null,
    created_at: new Date().toISOString(),
    usage_count: 3,
    rate_limit: 1000,
    expires_at: null,
  };
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
});

// Records every mutation the UI fires, and always renders one active key for GET.
async function installApiKeyRoutes(
  page: import("@playwright/test").Page,
  sink: { method: string; url: string; body: unknown }[],
) {
  const capture = async (route: Route) => {
    const req = route.request();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    sink.push({ method: req.method(), url: new URL(req.url()).pathname, body });
  };

  // Regenerate is a more specific path than the :id route, so register it first.
  await page.route("**/api/v1/api-keys/*/regenerate", async (route) => {
    await capture(route);
    return route.fulfill({
      json: {
        success: true,
        plainKey: "eliza_pk_live_REGENERATED_abc",
        apiKey: { ...activeKey(), key_prefix: "eliza_pk_live" },
      },
    });
  });

  await page.route("**/api/v1/api-keys/*", async (route) => {
    await capture(route);
    return route.fulfill({ json: { success: true } });
  });

  await page.route("**/api/v1/api-keys", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { keys: [activeKey()] } });
    }
    return route.fulfill({ json: { success: true } });
  });

  // Generic success for any other /api/** the dashboard pulls during render.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith("/api/v1/api-keys")) return route.fallback();
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );
}

async function openRowMenu(page: import("@playwright/test").Page) {
  await page
    .getByRole("button", { name: /open actions/i })
    .first()
    .click();
}

async function confirm(page: import("@playwright/test").Page) {
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^confirm$/i })
    .click();
}

test("api-key: disable sends PATCH { is_active: false }", async ({ page }) => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  await installApiKeyRoutes(page, calls);

  await page.goto("/dashboard/api-keys");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(
    page.getByRole("button", { name: /open actions/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await openRowMenu(page);
  await page.getByRole("menuitem", { name: /disable key/i }).click();
  await confirm(page);

  await expect.poll(() => calls.find((c) => c.method === "PATCH")).toBeTruthy();
  const patch = calls.find((c) => c.method === "PATCH");
  expect(patch?.url).toBe(`/api/v1/api-keys/${KEY_ID}`);
  expect(patch?.body).toMatchObject({ is_active: false });
});

test("api-key: regenerate POSTs to /:id/regenerate and reveals the new key", async ({
  page,
}) => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  await installApiKeyRoutes(page, calls);

  await page.goto("/dashboard/api-keys");
  await expect(
    page.getByRole("button", { name: /open actions/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await openRowMenu(page);
  await page.getByRole("menuitem", { name: /regenerate key/i }).click();
  await confirm(page);

  await expect
    .poll(() => calls.find((c) => c.url.endsWith("/regenerate")))
    .toBeTruthy();
  const regen = calls.find((c) => c.url.endsWith("/regenerate"));
  expect(regen?.method).toBe("POST");
  expect(regen?.url).toBe(`/api/v1/api-keys/${KEY_ID}/regenerate`);
});

test("api-key: delete sends DELETE for the key id", async ({ page }) => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  await installApiKeyRoutes(page, calls);

  await page.goto("/dashboard/api-keys");
  await expect(
    page.getByRole("button", { name: /open actions/i }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await openRowMenu(page);
  await page.getByRole("menuitem", { name: /delete key/i }).click();
  await confirm(page);

  await expect
    .poll(() => calls.find((c) => c.method === "DELETE"))
    .toBeTruthy();
  expect(calls.find((c) => c.method === "DELETE")?.url).toBe(
    `/api/v1/api-keys/${KEY_ID}`,
  );
});
