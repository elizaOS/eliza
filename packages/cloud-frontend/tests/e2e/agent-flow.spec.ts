// Agent flow — entry → first chat message.
//
// Walks the critical "get an agent running" UX:
//   1. /  → Launch Eliza CTA → /login
//   2. Stub auth via the eliza-test-auth cookie + VITE_PLAYWRIGHT_TEST_AUTH=true
//      build flag (same pattern as api-key-flow.spec.ts).
//   3. /dashboard/agents (Instances list, empty state)
//   4. Click "New Agent" → CreateElizaAgentDialog form
//   5. Fill name, deploy → ProvisioningProgress → poll transitions to running
//   6. Navigate to /chat/:characterRef and send a first message.
//
// All network calls are stubbed via page.route() — we do not touch a real
// backend, do not actually provision a container, and do not actually send a
// model request. We only assert the UI elements respond as expected.

import { type BrowserContext, expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Agent flow uses local mocks; skipped in live-prod mode",
);

const FAKE_AGENT_ID = "11111111-1111-1111-1111-111111111111";
const FAKE_CHARACTER_ID = "22222222-2222-2222-2222-222222222222";
const FAKE_JOB_ID = "33333333-3333-3333-3333-333333333333";

async function installTestAuthCookie(context: BrowserContext) {
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
}

test("agent flow: landing → login → create agent → chat", async ({
  context,
  page,
}) => {
  // ── Stub backend endpoints the dashboard touches ───────────────────────
  // Credits balance (banner)
  await page.route("**/api/credits/balance**", (route) =>
    route.fulfill({ json: { balance: 1000 } }),
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

  // Agents list — first call returns empty (drives the empty state + dialog).
  // After create, the table re-fetches; return one running agent.
  let listCallCount = 0;
  await page.route("**/api/v1/eliza/agents", (route) => {
    if (route.request().method() === "POST") {
      // Create
      return route.fulfill({
        json: { success: true, data: { id: FAKE_AGENT_ID } },
      });
    }
    listCallCount += 1;
    const agents =
      listCallCount === 1
        ? []
        : [
            {
              id: FAKE_AGENT_ID,
              agentName: "playwright-agent",
              status: "running",
              errorMessage: null,
              lastHeartbeatAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ];
    return route.fulfill({ json: { success: true, data: agents } });
  });

  // Provision queue
  await page.route(
    `**/api/v1/eliza/agents/${FAKE_AGENT_ID}/provision`,
    (route) =>
      route.fulfill({
        status: 202,
        json: { success: true, data: { jobId: FAKE_JOB_ID } },
      }),
  );

  await page.route(`**/api/v1/jobs/${FAKE_JOB_ID}`, (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          id: FAKE_JOB_ID,
          status: "completed",
          result: { agentId: FAKE_AGENT_ID },
        },
      },
    }),
  );

  // Status poll inside the create dialog — flip straight to "running"
  await page.route(`**/api/v1/eliza/agents/${FAKE_AGENT_ID}`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          success: true,
          data: {
            id: FAKE_AGENT_ID,
            agentName: "playwright-agent",
            status: "running",
            errorMessage: null,
            lastHeartbeatAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      });
    }
    return route.fallback();
  });

  // ── 1. Landing → Launch CTA → /login ───────────────────────────────────
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /launch eliza/i }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /launch eliza/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole("heading", { name: /sign in/i }).first(),
  ).toBeVisible();

  // ── 2. Skip the real auth handshake: the test cookie + the build-time
  //      VITE_PLAYWRIGHT_TEST_AUTH flag short-circuit useSessionAuth so a
  //      direct hit to /dashboard/agents renders authenticated.
  await installTestAuthCookie(context);
  await page.goto("/dashboard/agents");
  await expect(
    page.locator("#main").getByRole("heading", { name: /instances/i }),
  ).toBeVisible();

  // ── 3. Empty state → click "New Agent" ─────────────────────────────────
  await expect(page.getByText(/no agents yet/i)).toBeVisible();
  await page
    .getByRole("button", { name: /new agent/i })
    .first()
    .click();

  // ── 4. Fill form, deploy ───────────────────────────────────────────────
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/agent name/i).fill("playwright-agent");
  await dialog.getByRole("button", { name: /deploy/i }).click();

  // ── 5. Provisioning view appears, transitions back to the running list ──
  await expect(dialog.getByText(/launching agent/i)).toBeVisible();

  // Back on the list, the running agent should now appear.
  await expect(
    page.getByRole("link", { name: "playwright-agent" }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // ── 6. Chat surface ────────────────────────────────────────────────────
  // Stub the public character lookup so /chat/:characterRef renders the
  // chat interface without a real character record.
  await page.route(`**/api/characters/*/public`, (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          id: FAKE_CHARACTER_ID,
          name: "playwright-agent",
          username: "playwright-agent",
          avatarUrl: null,
          bio: "test character",
          creatorUsername: "test",
        },
      },
    }),
  );

  await page.route("**/api/v1/models", (route) =>
    route.fulfill({ json: { object: "list", data: [] } }),
  );
  await page.route("**/api/v1/models/status", async (route) => {
    const body = route.request().postDataJSON() as
      | { modelIds?: string[] }
      | undefined;
    return route.fulfill({
      json: {
        models: (body?.modelIds ?? []).map((modelId) => ({
          modelId,
          available: true,
        })),
        timestamp: Date.now(),
      },
    });
  });
  await page.route("**/api/elevenlabs/voices/user", (route) =>
    route.fulfill({ json: { voices: [] } }),
  );
  await page.route("**/api/eliza/rooms", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        json: { roomId: "room_1" },
      });
    }
    return route.fulfill({ json: { rooms: [] } });
  });
  await page.route("**/api/eliza/rooms/*/messages/stream", (route) =>
    route.fulfill({ status: 200, body: "" }),
  );

  // Stub the streaming message endpoint — we don't care about the response,
  // only that the UI lets the user submit.
  await page.route("**/api/chat/**", (route) =>
    route.fulfill({ status: 200, body: "" }),
  );

  await page.goto(`/chat/${FAKE_CHARACTER_ID}`);

  // Chat input + Send button should be present and enabled after typing.
  const chatInput = page.getByPlaceholder(/type your message/i);
  await expect(chatInput).toBeVisible({ timeout: 15_000 });
  await chatInput.fill("hello agent");
  const sendButton = page.locator('button[type="submit"]').last();
  await expect(sendButton).toBeEnabled();
  // Click but don't assert any network behavior — we only verify the UI
  // accepted the submission affordance.
  await sendButton.click();
});
