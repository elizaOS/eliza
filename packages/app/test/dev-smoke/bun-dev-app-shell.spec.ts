/**
 * Development smoke spec for the Bun Dev App Shell Bun dev app boot path.
 */
import { expect, test } from "@playwright/test";

/**
 * Provider-INDEPENDENT dev-server render guard (#9452).
 *
 * The sibling `bun-dev-onboarding-chat.spec.ts` `test.skip()`s without a live
 * provider key, so on most CI runs the dev-smoke lane went green-via-skip — and
 * a whole class of "the app never mounts" regression slipped through unseen. The
 * concrete one (#9452): a workspace `import { Buffer } from "node:buffer"`
 * (e.g. `@elizaos/core`'s `features/documents/utils`, re-exported from both core
 * barrels and therefore eager) was served by the vite dev server as raw,
 * untransformed CommonJS — `noDiscovery` is on and `buffer` was not pre-bundled,
 * so the `buffer`/`node:buffer` → feross-`index.js` alias resolved to a CJS file
 * the browser's ESM loader can't evaluate. It threw "does not provide an export
 * named 'Buffer'" at module-eval, blanking the ENTIRE React tree on every route
 * (the production rollup build is unaffected, which is why only this lane was
 * red). The chat composer never painting was just the visible symptom.
 *
 * This spec runs unconditionally and asserts the cheapest invariant that the
 * crash violates: the shell mounts *something* into `#root` and no fatal
 * module-eval error fires. It needs no onboarding, no provider, and no model —
 * the startup/first-run screen is enough to prove the bundle evaluates.
 */
test.describe("bun run dev app shell renders", () => {
  test("mounts the React shell without a fatal module-eval error", async ({
    page,
  }) => {
    const fatalErrors: string[] = [];
    page.on("pageerror", (error) => {
      fatalErrors.push(error.message);
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // A blank `#root` means a module-eval crash blanked the tree (the #9452
    // failure mode). Any startup/onboarding/app content satisfies this.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.getElementById("root")?.childElementCount ?? 0,
          ),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    expect(
      fatalErrors,
      `fatal page errors during boot:\n${fatalErrors.join("\n")}`,
    ).toEqual([]);
  });
});
