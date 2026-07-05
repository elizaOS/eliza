/**
 * Playwright UI-smoke spec for the Walkthrough Capture Smoke app flow using
 * the real renderer fixture.
 */
import {
  expect,
  type Page,
  type Route,
  type TestInfo,
  test,
} from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "../helpers";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const USER_TEXT = "walkthrough capture smoke message";
const ASSISTANT_TEXT = "Walkthrough capture reply.";

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

async function installMutableFirstRunStatus(page: Page): Promise<{
  setComplete: (complete: boolean) => void;
}> {
  let complete = false;
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      complete,
      cloudProvisioned: complete,
    });
  });
  return {
    setComplete(nextComplete) {
      complete = nextComplete;
    },
  };
}

async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ELIZA_APP_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, number>).__electrobunWindowId = 1;
  });
}

async function installWalkthroughConversationStore(page: Page): Promise<void> {
  const conversation = {
    id: "walkthrough-conversation",
    roomId: "walkthrough-room",
    title: "Walkthrough capture",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
  }> = [];
  let created = false;
  let sequence = 0;

  await page.route("**/api/conversations", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await fulfillJson(route, 200, {
        conversations: created ? [conversation] : [],
      });
      return;
    }
    if (method === "POST") {
      created = true;
      await fulfillJson(route, 200, { conversation });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "**/api/conversations/walkthrough-conversation/messages**",
    async (route) => {
      if (route.request().method() === "GET") {
        await fulfillJson(route, 200, { messages });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    "**/api/conversations/walkthrough-conversation/messages/stream",
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      const userText = (body.text ?? "").trim();
      sequence += 1;
      messages.push({
        id: `walkthrough-user-${sequence}`,
        role: "user",
        text: userText,
        timestamp: Date.now(),
      });
      messages.push({
        id: `walkthrough-assistant-${sequence}`,
        role: "assistant",
        text: ASSISTANT_TEXT,
        timestamp: Date.now(),
      });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({
            type: "token",
            text: ASSISTANT_TEXT,
            fullText: ASSISTANT_TEXT,
          })}\n\n` +
          `data: ${JSON.stringify({
            type: "done",
            fullText: ASSISTANT_TEXT,
            agentName: "Eliza",
          })}\n\n`,
      });
    },
  );

  await page.route(
    "**/api/conversations/walkthrough-conversation/greeting**",
    async (route) => {
      await fulfillJson(route, 200, {
        text: "Ready for the walkthrough.",
        localInference: null,
      });
    },
  );

  await page.route(
    "**/api/conversations/walkthrough-conversation",
    async (route) => {
      if (route.request().method() === "PATCH") {
        await fulfillJson(route, 200, { conversation });
        return;
      }
      await route.fallback();
    },
  );
}

async function captureState(
  page: Page,
  testInfo: TestInfo,
  filename: string,
): Promise<void> {
  if (!process.env.E2E_RECORD) return;
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(filename, { path, contentType: "image/png" });
}

/**
 * Flick the open chat sheet's grabber up to the FULL detent — the pull gesture
 * that replaced the removed `chat-full-maximize` button (#13531/#14332). A
 * few-step, large-travel `page.mouse` drag clears the flick velocity threshold
 * so the sheet snaps up a detent; retried since a single flick can land at HALF
 * first.
 */
async function flickSheetToFull(page: Page): Promise<void> {
  const sheet = page.getByTestId("chat-sheet");
  await expect(page.getByTestId("continuous-chat-overlay")).toHaveAttribute(
    "data-open",
    "true",
    { timeout: 15_000 },
  );
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await sheet.getAttribute("data-detent")) === "full") return;
    const box = await page.getByTestId("chat-sheet-grabber").boundingBox();
    if (!box) throw new Error("no bounding box for chat-sheet-grabber");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const travel = Math.min(cy - 4, 560);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 3; i += 1) {
      await page.mouse.move(cx, cy - (travel * i) / 3);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await expect(sheet).toHaveAttribute("data-detent", "full", {
    timeout: 5_000,
  });
}

test.describe("walkthrough capture smoke", () => {
  test("captures the first stable walkthrough states", async ({
    page,
  }, testInfo) => {
    installPageDiagnosticsGuard(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    await injectFullCapabilityHost(page);
    await installDefaultAppRoutes(page);
    const firstRun = await installMutableFirstRunStatus(page);
    await installWalkthroughConversationStore(page);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    const onboarding = page.getByTestId("continuous-chat-overlay");
    await expect(onboarding).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText("Sign in to Eliza Cloud and I'll get you set up.", {
        exact: false,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
    await expect(
      page.getByTestId("choice-__first_run__:runtime:cloud"),
    ).toBeVisible();
    await expect(
      page.getByTestId("choice-__first_run__:runtime:local"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("choice-__first_run__:runtime:remote"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("choice-__first_run__:runtime:other"),
    ).toHaveCount(0);
    await captureState(page, testInfo, "walkthrough-01-onboarding.png");

    firstRun.setComplete(true);
    await page.evaluate(() => {
      localStorage.setItem("eliza:first-run-complete", "1");
    });
    await openAppPath(page, "/chat");
    const overlay = page.getByTestId("continuous-chat-overlay");
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    const setupSkip = page.getByRole("button", { name: "Skip for now" });
    if (await setupSkip.isVisible().catch(() => false)) {
      await setupSkip.click();
      await expect(setupSkip).toBeHidden({ timeout: 10_000 });
    }
    await captureState(page, testInfo, "walkthrough-02-chat-ready.png");

    const composer = page.locator(CHAT_COMPOSER_SELECTOR).first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill(USER_TEXT);
    await page.getByTestId("chat-composer-action").click();
    await expect(overlay).toHaveAttribute("data-open", "true", {
      timeout: 15_000,
    });
    await expect(
      page.getByTestId("thread-line").filter({ hasText: USER_TEXT }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page
        .getByTestId("thread-line")
        .filter({ hasText: ASSISTANT_TEXT })
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await captureState(page, testInfo, "walkthrough-03-chat-round-trip.png");

    await flickSheetToFull(page);
    await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
      "data-detent",
      "full",
      { timeout: 10_000 },
    );
    await captureState(page, testInfo, "walkthrough-04-chat-full-detent.png");

    await openAppPath(page, "/views");
    await expect(page.getByTestId("launcher")).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.locator('[data-testid^="launcher-tile-"]').first(),
    ).toBeVisible();
    await captureState(page, testInfo, "walkthrough-05-launcher.png");

    const firstTile = page.locator('[data-testid^="launcher-tile-"]').first();
    const tileId = await firstTile.getAttribute("data-testid");
    const viewId = (tileId ?? "").replace("launcher-tile-", "");
    await firstTile.locator("button").first().click();
    await expect
      .poll(() => new URL(page.url()).hash + new URL(page.url()).pathname)
      .not.toContain("/views");
    expect(viewId.length).toBeGreaterThan(0);
    await captureState(page, testInfo, "walkthrough-06-launched-view.png");

    await expectNoPageDiagnostics(page, "walkthrough capture smoke");
  });
});
