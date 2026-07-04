/**
 * Real-browser e2e for the chromeless desktop bottom bar (#9953) — no app server.
 * Renders the REAL shell components (HomePill + AssistantOverlay + ChatSurface
 * glass composer) over the compiled @elizaos/ui theme and drives the
 * resting→open→type→vision flow with real input, asserting the #9953 acceptance
 * criteria: the resting surface is the chromeless bar (not the full <App>); the
 * open composer shows mic + VISION + send; the VISION tap fires a screen-vision
 * turn; and no hardcoded blue (`is-sky`) anywhere. Mechanics + theme compile come
 * from the shared e2e-runner.
 *
 * Run: bun run --cwd packages/ui test:bottombar-e2e
 * Exits non-zero on any failed assertion or page/console error.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileTailwindTheme,
  runBrowserFixtureE2E,
  stubElizaCore,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../../../.."); // packages/ui
const outDir = process.env.BOTTOMBAR_OUT || join(here, "output-bottombar");

// Compile the REAL @elizaos/ui Tailwind v4 theme scoped to the shell so captured
// pixels carry the shipped brand (dark glass + orange accent), not a CDN approx.
const themeCss = await compileTailwindTheme({
  uiRoot,
  sources: [join(uiRoot, "src/components/shell"), here],
});

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "bottombar-fixture.tsx"),
      outDir,
      htmlName: "bottombar.html",
      title: "bottom bar e2e",
      plugins: [stubElizaCore(), stubNodeBuiltins()],
      processShim: true,
      // `class="dark"` activates the shipped dark-glass theme tokens.
      htmlClass: "dark",
      tailwind: { css: themeCss },
      background: "#08080d",
    },
    context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
    record: { name: "bottombar-flow.webm" },
    // Windows Defender can stall the first CDP handshake; keep a generous budget.
    launchTimeoutMs: Number(process.env.PW_LAUNCH_TIMEOUT_MS || 300000),
    waitFor: '[data-testid="shell-home-pill"]',
    passMessage: `\nPASS — artifacts in ${outDir}`,
  },
  async ({ page, gate, snap, logs, errors }) => {
    const { assert } = gate;
    await page.waitForTimeout(900);

    // 1) RESTING: the chromeless bar (HomePill) is the resting surface; the full
    //    AssistantOverlay composer is NOT mounted yet.
    assert(
      (await page.getByTestId("shell-home-pill").count()) === 1,
      "RESTING: chromeless HomePill bar is the resting surface (not <App>)",
    );
    assert(
      (await page.getByTestId("shell-chat-surface").count()) === 0,
      "RESTING: the open composer is not mounted until the bar is opened",
    );
    await snap(page, "resting-homepill");

    // 2) OPEN: click the pill → AssistantOverlay mounts the glass ChatSurface.
    await page.getByTestId("shell-home-pill").click({ force: true });
    await page.waitForSelector('[data-testid="shell-assistant-overlay"]', { timeout: 8000 });
    await page.waitForSelector('[data-testid="shell-chat-surface"]', { timeout: 8000 });
    await page.waitForTimeout(900);
    await snap(page, "open-composer");

    // 3) The composer shows mic + VISION + send (the #9953 acceptance addition).
    const micLabels = await page.$$eval("button", (els) =>
      els.map((e) => e.getAttribute("aria-label") || "").filter((l) => /voice input/i.test(l)),
    );
    const visionLabels = await page.$$eval("button", (els) =>
      els.map((e) => e.getAttribute("aria-label") || "").filter((l) => /my screen/i.test(l)),
    );
    const sendLabels = await page.$$eval("button", (els) =>
      els.map((e) => e.getAttribute("aria-label") || "").filter((l) => /send message/i.test(l)),
    );
    assert(micLabels.length === 1, `COMPOSER: mic button present (${JSON.stringify(micLabels)})`);
    assert(visionLabels.length === 1, `COMPOSER: VISION button present (${JSON.stringify(visionLabels)})`);
    assert(sendLabels.length === 1, `COMPOSER: send button present (${JSON.stringify(sendLabels)})`);

    // 4) NO BLUE: the #9953 `is-sky` brand violation is gone.
    const skyCount = await page.$$eval(
      "*",
      (els) => els.filter((e) => e.className && String(e.className).includes("is-sky")).length,
    );
    assert(skyCount === 0, `BRAND: no \`is-sky\` blue elements (${skyCount})`);

    // 5) TYPE → send button enables, Enter sends.
    const input = page.getByTestId("shell-chat-surface").locator('input[type="text"]');
    await input.fill("close out 9953");
    await page.waitForTimeout(300);
    await snap(page, "open-composer-draft");
    const before = logs.length;
    await input.press("Enter");
    await page.waitForTimeout(300);
    assert(
      logs.slice(before).some((l) => l.includes("[fixture] send: close out 9953")),
      "SEND: pressing Enter sends the drafted turn",
    );

    // 6) VISION tap → fires a screen-vision turn (pulses the button).
    const beforeV = logs.length;
    await page.getByRole("button", { name: /my screen/i }).click({ force: true });
    await page.waitForTimeout(300);
    assert(
      logs.slice(beforeV).some((l) => l.includes("captureVision -> screen turn")),
      "VISION: tapping the eye fires a screen-vision turn",
    );
    assert(
      logs.slice(beforeV).some((l) => l.includes("Take a look at my screen")),
      "VISION: the screen-vision turn text is sent to the agent",
    );
    await snap(page, "vision-active");

    // 7) Close → back to the resting chromeless bar.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    assert(
      (await page.getByTestId("shell-chat-surface").count()) === 0,
      "CLOSE: Escape returns to the resting chromeless bar",
    );
    await snap(page, "closed-back-to-bar");

    assert(errors.length === 0, `NO PAGE ERRORS (${JSON.stringify(errors.slice(0, 4))})`);
    const errLogs = logs.filter((l) => l.startsWith("[error]"));
    assert(errLogs.length === 0, `NO console errors (${JSON.stringify(errLogs.slice(0, 4))})`);
  },
);
