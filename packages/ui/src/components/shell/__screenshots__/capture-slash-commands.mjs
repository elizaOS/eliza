/**
 * Capture slash-command menu states from the live Storybook story.
 *
 *   1. bun run --cwd packages/ui storybook   # or preview "storybook" (port 6006)
 *   2. node packages/ui/src/components/shell/__screenshots__/capture-slash-commands.mjs
 *
 * Writes PNGs to ./slash-commands/. Pure verification artifact — not wired into CI.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "slash-commands");
const STORY =
  "http://localhost:6006/iframe.html?id=shell-continuouschatoverlay--slash-commands&viewMode=story";

const TYPE_VALUE = `(value) => {
  const input = document.querySelector('[data-testid="chat-composer-textarea"]');
  input.focus();
  // The composer is a <textarea> — use the textarea value setter (the input one
  // throws "Illegal invocation").
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}`;

const STATES = [
  // Resting transcript — shows the prior `/help` user turn rendered bold.
  { name: "00-transcript-bold", value: "" },
  { name: "01-all-commands", value: "/" },
  { name: "02-filtered", value: "/se" },
  { name: "03-settings-sections", value: "/settings " },
  { name: "04-settings-filtered", value: "/settings mo" },
];

const VIEWPORTS = [
  { tag: "desktop", width: 1280, height: 800 },
  { tag: "mobile", width: 390, height: 844 },
];

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
    });
    await page.goto(STORY, { waitUntil: "domcontentloaded" });
    // Storybook compiles the story on first request; wait for the textarea to be
    // attached (it may be collapsed/offscreen until focused, so don't require
    // visibility here).
    try {
      await page.waitForSelector('[data-testid="chat-composer-textarea"]', {
        state: "attached",
        timeout: 60000,
      });
    } catch (err) {
      const html = await page.content();
      console.error("composer not found; page sample:\n", html.slice(0, 2000));
      throw err;
    }
    // Focus the composer so the overlay expands (the resting bar collapses it).
    await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="chat-composer-textarea"]',
      );
      el?.focus();
      el?.scrollIntoView();
    });
    await page.waitForTimeout(400);
    for (const state of STATES) {
      await page.evaluate(`(${TYPE_VALUE})(${JSON.stringify(state.value)})`);
      await page.waitForTimeout(350);
      const file = path.join(OUT, `${state.name}--${vp.tag}.png`);
      await page.screenshot({ path: file });
      console.log("wrote", path.relative(process.cwd(), file));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
