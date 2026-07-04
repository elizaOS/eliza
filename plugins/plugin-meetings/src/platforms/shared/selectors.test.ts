/**
 * waitForAnySelector selector racing — first-match resolution across an ordered
 * selector list, where a per-selector timeout never aborts the others.
 * Deterministic: a fake page with scripted per-selector delays.
 */

import type { ElementHandle, Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { waitForAnySelector } from "./selectors.js";

/**
 * Fake page: each selector resolves after `delays[selector]` ms with a stub
 * handle, or rejects (never matches) when the delay is undefined.
 */
function fakePage(delays: Record<string, number>): Page {
  return {
    waitForSelector: (selector: string) =>
      new Promise((resolve, reject) => {
        const d = delays[selector];
        if (d === undefined) {
          setTimeout(() => reject(new Error("timeout")), 5);
          return;
        }
        setTimeout(
          () => resolve({ selector } as unknown as ElementHandle<Element>),
          d,
        );
      }),
  } as unknown as Page;
}

describe("waitForAnySelector selector racing", () => {
  it("resolves with the FIRST selector to match (not list order)", async () => {
    const page = fakePage({ "b-fast": 5, "a-slow": 40 });
    const { selector } = await waitForAnySelector(
      page,
      ["a-slow", "b-fast"],
      1000,
      "control",
    );
    expect(selector).toBe("b-fast");
  });

  it("ignores non-matching selectors and still resolves a later match", async () => {
    // First two never match; third matches.
    const page = fakePage({ "eng-fallback": 20 });
    const { selector } = await waitForAnySelector(
      page,
      ["structural-a", "structural-b", "eng-fallback"],
      1000,
      "join button",
    );
    expect(selector).toBe("eng-fallback");
  });

  it("throws LOUD listing every selector when none match", async () => {
    const page = fakePage({});
    await expect(
      waitForAnySelector(page, ["x", "y", "z"], 50, "name input"),
    ).rejects.toThrow(/could not locate name input.*x \| y \| z/);
  });

  it("throws immediately for an empty selector list", async () => {
    const page = fakePage({});
    await expect(waitForAnySelector(page, [], 50, "empty")).rejects.toThrow(
      /could not locate empty/,
    );
  });
});
