// prefers-reduced-motion collapse spec for the dashboard shell (#9141, task 7).
//
// The shell honors reduced motion two ways: framer-motion components read
// `useReducedMotion()` (ContinuousChatOverlay.tsx:1068, gating message enter/exit
// + the turn-status fade), and CSS animations carry Tailwind's `motion-reduce:`
// variant (e.g. the typing-dots `animate-pulse motion-reduce:animate-none`). This
// spec forces `prefers-reduced-motion: reduce` and proves both mechanisms hold:
//   1. the media query the framer-motion hook reads is actually `reduce`, and
//   2. the `motion-reduce:animate-none` CSS contract the shell relies on resolves
//      to NO animation under reduce and a real animation without it, and
//   3. no element currently in the shell DOM that opts into `motion-reduce:` is
//      left running a CSS animation.

import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.describe("shell honors prefers-reduced-motion", () => {
  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    // Force the reduced-motion preference before any navigation so the app boots
    // with it in effect (framer-motion reads matchMedia at mount).
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("reduce collapses CSS + framer-motion shell animation", async ({
    page,
  }, testInfo) => {
    await openAppPath(page, "/chat");
    await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
      timeout: 60_000,
    });

    // 1. The media query the framer-motion useReducedMotion() hook reads is reduce.
    const matchesReduce = await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    expect(matchesReduce, "prefers-reduced-motion: reduce must be active").toBe(
      true,
    );

    // 2. The `motion-reduce:animate-none` contract the shell depends on: a probe
    //    using the exact utilities (compiled into the app's Tailwind CSS by the
    //    typing-dots) must NOT animate under reduce…
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "animate-pulse motion-reduce:animate-none";
      el.setAttribute("data-perf-probe", "reduced-motion");
      document.body.appendChild(el);
    });
    const probeName = '[data-perf-probe="reduced-motion"]';
    const reducedAnim = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).animationName : "missing";
    }, probeName);
    expect(
      reducedAnim,
      "animate-pulse motion-reduce:animate-none must resolve to no animation under reduce",
    ).toBe("none");

    // …and DOES animate once the preference is lifted (proves the variant is real,
    // not just globally-stripped animation).
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const normalAnim = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).animationName : "missing";
    }, probeName);
    expect(
      normalAnim,
      "without reduce the same utilities must drive a real CSS animation",
    ).not.toBe("none");

    // Restore reduce for the live-DOM scan.
    await page.emulateMedia({ reducedMotion: "reduce" });

    // 3. No element the shell DOM opts into `motion-reduce:animate-none` is left
    //    running a CSS animation under reduce. Vacuously true if none are mounted
    //    at rest (the contract is still pinned by the probe above), but catches a
    //    real regression where a shell surface animates despite reduced motion.
    const offenders = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll('[class*="motion-reduce:animate-none"]'),
      );
      return nodes
        .filter((el) => {
          const name = getComputedStyle(el).animationName;
          return name && name !== "none";
        })
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 60)}`,
        );
    });
    testInfo.annotations.push({
      type: "reduced-motion",
      description: `scanned motion-reduce elements; running-animation offenders: ${offenders.length}`,
    });
    expect(
      offenders,
      `shell elements animating despite reduced motion: ${JSON.stringify(offenders)}`,
    ).toEqual([]);

    await page.screenshot({
      path: testInfo.outputPath("reduced-motion-chat.png"),
    });
  });
});
