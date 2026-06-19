import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "API Explorer flow uses local test auth and API stubs; skipped in live-prod mode",
);

const EXPLORER_KEY = "eliza_test_explorer_123";

test.beforeEach(async ({ context, page, browserName }) => {
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

  if (browserName === "chromium") {
    const origin = new URL(
      process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:4173",
    ).origin;
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
  }

  await page.route("**/api/v1/api-keys/explorer", (route) =>
    route.fulfill({
      json: {
        apiKey: {
          id: "explorer_key_1",
          name: "API Explorer",
          description: "Generated for API Explorer tests",
          key_prefix: "eliza_test_explorer",
          key: EXPLORER_KEY,
          created_at: new Date().toISOString(),
          is_active: true,
          usage_count: 7,
          last_used_at: null,
        },
      },
    }),
  );

  await page.route("**/api/v1/pricing/summary", (route) =>
    route.fulfill({
      json: {
        pricing: {
          "chat-completions": {
            cost: 0.0025,
            unit: "1k tokens",
            description: "Input tokens",
            isVariable: true,
            estimatedRange: { min: 0.001, max: 0.03 },
          },
        },
      },
    }),
  );

  await page.route("**/api/credits/balance", (route) =>
    route.fulfill({ json: { balance: 100 } }),
  );

  await page.route("**/api/v1/user", (route) =>
    route.fulfill({
      json: {
        success: true,
        user: {
          id: "user_1",
          email: "playwright@example.com",
          name: "Playwright User",
        },
      },
    }),
  );
});

test("api explorer: search, auth, request tester, response, and OpenAPI export", async ({
  page,
}) => {
  let chatRequest:
    | {
        authorization: string | null;
        body: unknown;
      }
    | undefined;

  await page.route("**/api/v1/chat", async (route) => {
    chatRequest = {
      authorization: route.request().headers().authorization ?? null,
      body: route.request().postDataJSON(),
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        id: "chatcmpl_playwright",
        model: "gpt-oss-120b",
        choices: [
          {
            message: {
              role: "assistant",
              content: "API Explorer request accepted",
            },
          },
        ],
      },
    });
  });

  await page.goto("/dashboard/api-explorer");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: /Endpoints/i })).toBeVisible();

  await page.getByPlaceholder("Search...").fill("chat completion");
  await expect(page.getByText(/1 endpoint matching/i)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Chat Completion/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: /AI Completions/i }).click();
  await expect(
    page.getByRole("heading", { name: "AI Completions" }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Chat Completion/i }).click();
  await expect(
    page.getByRole("button", { name: /Back to endpoints/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Chat Completion" }),
  ).toBeVisible();

  const messages = page.locator("#param-messages");
  await expect(messages).toBeVisible();
  await messages.fill(
    JSON.stringify([
      {
        role: "user",
        parts: [{ type: "text", text: "Say hello from Playwright" }],
      },
    ]),
  );

  await page.getByRole("button", { name: /Copy cURL/i }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("/api/v1/chat");

  await page.getByRole("button", { name: /Send Request/i }).click();
  await expect(page.getByRole("tab", { name: /Response 200/i })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("API Explorer request accepted")).toBeVisible();
  expect(chatRequest?.authorization).toBe(`Bearer ${EXPLORER_KEY}`);
  expect(chatRequest?.body).toMatchObject({
    messages: [
      {
        role: "user",
        parts: [{ type: "text", text: "Say hello from Playwright" }],
      },
    ],
  });

  await page.getByRole("button", { name: /^Auth$/i }).click();
  const apiKeyInput = page.locator("#auth-manager-api-key");
  await expect(apiKeyInput).toHaveAttribute("type", "password");
  await expect(apiKeyInput).toHaveValue(EXPLORER_KEY);
  await page.locator("#auth-manager-api-key + button").click();
  await expect(apiKeyInput).toHaveAttribute("type", "text");

  await page.getByText("Use a different key").click();
  await page.getByPlaceholder("Enter custom API key...").fill("sk-custom-test");
  await expect(apiKeyInput).toHaveValue("sk-custom-test");
  await page.getByRole("button", { name: /Reset to default/i }).click();
  await expect(apiKeyInput).toHaveValue(EXPLORER_KEY);

  await page.getByRole("button", { name: /^OpenAPI$/i }).click();
  await expect(
    page.getByRole("heading", { name: "OpenAPI 3.0 Specification" }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^JSON$/i }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('"openapi"');

  await page.getByRole("button", { name: /^YAML$/i }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("openapi:");
});
