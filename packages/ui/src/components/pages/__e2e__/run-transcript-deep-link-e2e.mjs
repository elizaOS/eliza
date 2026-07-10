/**
 * Real-browser e2e for the Knowledge search → transcript player deep-link
 * (#14806) — no app server. Bundles the real DocumentsView (client/state
 * singletons substituted at the module boundary), renders it with the real
 * compiled @elizaos/ui Tailwind theme in headless Chromium, and drives the
 * whole flow with real gestures against a REAL in-page-synthesized WAV:
 *
 *   1. knowledge search           → anchored hit shows a 0:01–0:03 time badge;
 *                                   the plain hit shows none
 *   2. open the anchored hit      → the reader mounts the word-synced player
 *                                   SEEKED to the fragment's startMs (1.6 s in
 *                                   a genuine 3 s media element, not jsdom)
 *   3. press play                 → playback really advances from the seek
 *                                   point (currentTime grows past 1.6 s)
 *   4. back → open the plain hit  → the player opens at t=0 (no stale seek)
 *
 * Captures a screenshot per step + a video walkthrough into output-deep-link/.
 *
 * Run: bun run --cwd packages/ui test:transcript-deep-link-e2e
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileTailwindTheme,
  runBrowserFixtureE2E,
  stubElizaCore,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../../../..");
const outDir = join(here, "output-deep-link");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

/** Substitute the app-state / client singleton modules at the bundle boundary. */
function stubHostSingletons() {
  const stateStub = join(here, "transcript-deep-link-state-stub.ts");
  const clientStub = join(here, "transcript-deep-link-client-stub.ts");
  return {
    name: "stub-host-singletons",
    setup(build) {
      build.onResolve({ filter: /(^|\/)api\/client$/ }, () => ({
        path: clientStub,
      }));
      build.onResolve({ filter: /(^|\/)state$/ }, () => ({ path: stateStub }));
      build.onResolve({ filter: /(^|\/)state\/view-chat-binding$/ }, () => ({
        path: stateStub,
      }));
      build.onResolve({ filter: /(^|\/)utils\/desktop-dialogs$/ }, () => ({
        path: stateStub,
      }));
    },
  };
}

const themeCss = await compileTailwindTheme({
  uiRoot,
  sources: [
    join(uiRoot, "src/components/pages"),
    join(uiRoot, "src/components/transcripts"),
    join(uiRoot, "src/components/composites"),
    join(uiRoot, "src/components/ui"),
    join(uiRoot, "src/layouts"),
  ],
});

const audioTime = (page) =>
  page.evaluate(() => {
    const el = document.querySelector("audio");
    return el ? el.currentTime : null;
  });

await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "transcript-deep-link-fixture.tsx"),
      plugins: [stubHostSingletons(), stubElizaCore(), stubNodeBuiltins()],
      outDir,
      htmlName: "transcript-deep-link.html",
      title: "transcript deep-link e2e",
      tailwind: { css: themeCss },
      htmlClass: "dark",
      background: "#16121c",
      processShim: true,
    },
    context: { viewport: { width: 900, height: 720 } },
    record: { name: "transcript-deep-link-walkthrough.webm" },
    waitFor: "[data-testid='documents-view']",
    label: "transcript deep-link e2e",
  },
  async ({ page, gate, snap }) => {
    await snap(page, "knowledge-list");

    // 1. Search through the view's composer binding (the real search path).
    await page.evaluate(() =>
      window.__viewChatBinding?.onQuery?.("timestamp"),
    );
    await page.waitForSelector("[data-testid='result-anchor-frag-anchored']");
    const badge = await page
      .getByTestId("result-anchor-frag-anchored")
      .textContent();
    gate.assert(
      badge === "0:01–0:03",
      `anchored hit shows its time range badge (${badge})`,
    );
    gate.assert(
      (await page.locator("[data-testid='result-anchor-frag-plain']").count()) ===
        0,
      "plain hit shows no anchor badge",
    );
    await snap(page, "search-results-anchored-badge");

    // 2. Open the anchored hit → the real player seeks to the fragment start.
    await page.getByText("standup", { exact: true }).click();
    await page.waitForSelector("[data-testid='transcript-scrub']");
    await page.waitForFunction(() => {
      const el = document.querySelector("audio");
      return el !== null && el.currentTime > 1.55;
    });
    const seeked = await audioTime(page);
    gate.assert(
      seeked !== null && Math.abs(seeked - 1.6) < 0.1,
      `player opens seeked to the fragment startMs (currentTime=${seeked?.toFixed(3)}s ≈ 1.600s)`,
    );
    const scrubValue = await page
      .getByTestId("transcript-scrub")
      .inputValue();
    gate.assert(
      Math.abs(Number(scrubValue) - 1600) < 100,
      `scrub bar reflects the entry seek (${scrubValue}ms)`,
    );
    await snap(page, "reader-player-seeked");

    // 3. Play — real playback advances from the seek point.
    await page.getByTestId("transcript-play").click();
    await page.waitForFunction(() => {
      const el = document.querySelector("audio");
      return el !== null && el.currentTime > 1.75;
    });
    const playing = await audioTime(page);
    gate.assert(
      playing !== null && playing > 1.75 && playing < 3.2,
      `playback really advances from the seek point (currentTime=${playing?.toFixed(3)}s)`,
    );
    await snap(page, "playing-from-seek");
    await page.getByTestId("transcript-play").click();

    // 4. Back → open the plain hit → no stale seek leaks in (t=0).
    await page.getByLabel("Back to Knowledge").click();
    await page.waitForSelector("[data-testid='result-anchor-frag-anchored']");
    await page.getByText("notes", { exact: true }).click();
    await page.waitForSelector("[data-testid='transcript-scrub']");
    // Give any (incorrect) pending seek a beat to fire before asserting t=0.
    await page.waitForTimeout(600);
    const plain = await audioTime(page);
    gate.assert(
      plain !== null && plain < 0.05,
      `plain hit opens at t=0 (currentTime=${plain?.toFixed(3)}s)`,
    );
    await snap(page, "plain-hit-t0");

    // Mobile-width pass: the badge + seeked player render at 375px.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByLabel("Back to Knowledge").click();
    await page.waitForSelector("[data-testid='result-anchor-frag-anchored']");
    await snap(page, "mobile-search-results");
    await page.getByText("standup", { exact: true }).click();
    await page.waitForSelector("[data-testid='transcript-scrub']");
    await page.waitForFunction(() => {
      const el = document.querySelector("audio");
      return el !== null && el.currentTime > 1.55;
    });
    const mobileSeek = await audioTime(page);
    gate.assert(
      mobileSeek !== null && Math.abs(mobileSeek - 1.6) < 0.1,
      `mobile-width reader seeks identically (currentTime=${mobileSeek?.toFixed(3)}s)`,
    );
    await snap(page, "mobile-reader-seeked");
  },
);
