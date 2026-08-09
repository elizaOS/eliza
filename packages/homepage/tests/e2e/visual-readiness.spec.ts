/**
 * Browser contracts for the semantic boundaries that make homepage captures reproducible.
 *
 * CI runs these against software GL (SwiftShader) on loaded self-hosted
 * runners, where a single shader/model settle can take minutes. Every wait
 * and test budget here absorbs host load instead of encoding local timings.
 */

import { expect, type Page, test } from "playwright/test";
import sharp from "sharp";

const FIXED_TIME = new Date("2026-01-15T14:30:00.000Z");

// Software rasterization makes tiny per-channel rounding differences between
// two renders of the same scene possible; treat channel deltas at or below
// this threshold as identical.
const CHANNEL_TOLERANCE = 3;

test.use({
  reducedMotion: "reduce",
  timezoneId: "UTC",
  viewport: { width: 1280, height: 720 },
});

async function waitForTerminalChat(
  page: Page,
  renderedMessages: number,
  totalMessages = renderedMessages,
) {
  const state = page.locator("[data-phone-model]");
  // The multi-message replay is ~7s nominal but stretches far past 60s on
  // loaded CI runners with software GL (observed >60s in Deploy Homepage
  // runs); the settle wait must absorb host load, not local timings.
  await expect(state).toHaveAttribute("data-phone-model", "settled", {
    timeout: 120_000,
  });
  await expect(state).toHaveAttribute("data-chat-phase", "terminal");
  await expect(state).toHaveAttribute(
    "data-chat-rendered-messages",
    String(renderedMessages),
  );
  await expect(state).toHaveAttribute(
    "data-chat-total-messages",
    String(totalMessages),
  );
}

async function capturePhoneCanvas(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-shader-background]")).toHaveAttribute(
    "data-shader-background",
    "settled",
    { timeout: 60_000 },
  );
  await waitForTerminalChat(page, 5);

  const canvas = page.locator("[data-phone-scene] canvas");
  await expect(canvas).toBeVisible();
  await page.evaluate(() => {
    const scene = document.querySelector<HTMLElement>("[data-phone-scene]");
    const root = scene?.closest<HTMLElement>(".theme-app");
    if (!scene || !root) throw new Error("Phone scene root is not available");
    for (const child of root.children) {
      if (!(child instanceof HTMLElement) || child.contains(scene)) continue;
      child.dataset.captureVisibility = child.style.visibility;
      child.style.visibility = "hidden";
    }
    const sceneCanvas = scene.querySelector<HTMLCanvasElement>("canvas");
    if (!sceneCanvas) throw new Error("Phone scene canvas is not available");
    sceneCanvas.dataset.captureBackground = sceneCanvas.style.backgroundColor;
    sceneCanvas.style.backgroundColor = "#fff";
  });
  // Element screenshots wait on rAF frames, which arrive seconds apart under
  // SwiftShader; give the capture its own budget instead of the remaining
  // test time.
  const screenshot = await canvas.screenshot({
    animations: "disabled",
    timeout: 90_000,
  });
  await page.evaluate(() => {
    for (const child of document.querySelectorAll<HTMLElement>(
      "[data-capture-visibility]",
    )) {
      child.style.visibility = child.dataset.captureVisibility ?? "";
      delete child.dataset.captureVisibility;
    }
    const sceneCanvas = document.querySelector<HTMLCanvasElement>(
      "[data-phone-scene] canvas",
    );
    if (sceneCanvas) {
      sceneCanvas.style.backgroundColor =
        sceneCanvas.dataset.captureBackground ?? "";
      delete sceneCanvas.dataset.captureBackground;
    }
  });
  const capture = await sharp(screenshot)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let nonWhitePixels = 0;
  for (let offset = 0; offset < capture.data.length; offset += 4) {
    if (
      capture.data[offset] < 250 ||
      capture.data[offset + 1] < 250 ||
      capture.data[offset + 2] < 250
    ) {
      nonWhitePixels += 1;
    }
  }
  expect(nonWhitePixels).toBeGreaterThan(
    capture.info.width * capture.info.height * 0.01,
  );
  return capture;
}

async function swipeLeft(page: Page) {
  const surface = page.locator("div.theme-app").first();
  const box = await surface.boundingBox();
  if (!box) throw new Error("Homepage interaction surface is not available");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.65, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, y, { steps: 4 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test.describe(`landing alias equivalence - ${viewport.name}`, () => {
    test.use({ viewport });

    test("renders identical terminal phone canvases", async ({ page }) => {
      // Two full page loads, each with its own shader + model settle plus a
      // canvas capture; observed >120s per load on loaded CI runners.
      test.setTimeout(420_000);
      const landing = await capturePhoneCanvas(page, "/");
      const leaderboard = await capturePhoneCanvas(page, "/leaderboard");

      expect(landing.info).toEqual(leaderboard.info);
      let differingPixels = 0;
      for (let offset = 0; offset < landing.data.length; offset += 4) {
        if (
          Math.abs(landing.data[offset] - leaderboard.data[offset]) >
            CHANNEL_TOLERANCE ||
          Math.abs(landing.data[offset + 1] - leaderboard.data[offset + 1]) >
            CHANNEL_TOLERANCE ||
          Math.abs(landing.data[offset + 2] - leaderboard.data[offset + 2]) >
            CHANNEL_TOLERANCE ||
          Math.abs(landing.data[offset + 3] - leaderboard.data[offset + 3]) >
            CHANNEL_TOLERANCE
        ) {
          differingPixels += 1;
        }
      }
      const totalPixels = landing.info.width * landing.info.height;
      // The aliases must render the same settled scene; allow only a sliver
      // of rasterizer jitter (antialiased edges) before calling them
      // different.
      expect(differingPixels).toBeLessThanOrEqual(
        Math.ceil(totalPixels * 0.001),
      );
    });
  });
}

test("entering try mode commits the interrupted intro before readiness", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const state = page.locator("[data-phone-model]");
  await expect(state).toHaveAttribute("data-chat-phase", "animating", {
    timeout: 60_000,
  });
  await expect(state).toHaveAttribute("data-chat-rendered-messages", "1", {
    timeout: 60_000,
  });
  await expect(state).toHaveAttribute("data-chat-total-messages", "5");

  await page.getByRole("button", { name: "Discord" }).click();
  await expect(page.getByRole("button", { name: "Discord" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await swipeLeft(page);
  await waitForTerminalChat(page, 5);
  await expect(page.getByPlaceholder("Message #general")).toBeVisible();
});

test("Telegram replay moves from loading to its six-message terminal state", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForTerminalChat(page, 5);

  await page.evaluate(() => {
    const state = document.querySelector<HTMLElement>("[data-phone-model]");
    if (!state) throw new Error("Phone render state is not available");
    const observed: Array<Record<string, string | undefined>> = [];
    const record = () => {
      observed.push({
        model: state.dataset.phoneModel,
        phase: state.dataset.chatPhase,
        rendered: state.dataset.chatRenderedMessages,
        total: state.dataset.chatTotalMessages,
      });
    };
    new MutationObserver(record).observe(state, { attributes: true });
    Object.assign(window, { __homepageChatStates: observed });
    record();
  });
  await page.getByRole("button", { name: "Telegram" }).click();
  await expect(page.getByRole("button", { name: "Telegram" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("[data-phone-model]")).toHaveAttribute(
    "data-chat-total-messages",
    "6",
  );
  await waitForTerminalChat(page, 6);
  const observed = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __homepageChatStates: Array<Record<string, string | undefined>>;
        }
      ).__homepageChatStates,
  );
  expect(observed).toContainEqual({
    model: "loading",
    phase: "animating",
    rendered: "0",
    total: "6",
  });
});

test("rapid platform reversal honors the newest command", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForTerminalChat(page, 5);

  await page.getByRole("button", { name: "Telegram" }).click();
  await page.getByRole("button", { name: "iMessage" }).click();

  await expect(page.getByRole("button", { name: "iMessage" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await waitForTerminalChat(page, 5);
});
