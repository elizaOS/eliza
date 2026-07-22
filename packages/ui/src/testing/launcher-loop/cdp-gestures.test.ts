/**
 * Selector regression coverage for the real-browser launcher-loop driver. The
 * fixture intentionally renders an embedded launcher on Home beside the
 * dedicated launcher pane, so gestures must never target the offscreen copy.
 *
 * @vitest-environment jsdom
 */

import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { LAUNCHER_SELECTORS, readTileIds } from "./cdp-gestures";

describe("launcher-loop CDP selectors", () => {
  it("scopes grid gestures and tile discovery to the dedicated launcher pane", async () => {
    document.body.innerHTML = `
      <div data-testid="home-launcher-home-page">
        <div data-testid="launcher-page-window">
          <div data-testid="launcher-tile-offscreen-copy"></div>
        </div>
      </div>
      <div data-testid="home-launcher-launcher-page">
        <div data-testid="launcher-page-window">
          <div data-testid="launcher-tile-stream"></div>
          <div data-testid="launcher-tile-wallet"></div>
        </div>
      </div>
    `;

    const page = {
      $$eval: async <T>(
        selector: string,
        evaluate: (nodes: Element[]) => T,
      ): Promise<T> => evaluate([...document.querySelectorAll(selector)]),
    } as unknown as Page;

    await expect(readTileIds(page)).resolves.toEqual(["stream", "wallet"]);
    expect(
      document.querySelectorAll(LAUNCHER_SELECTORS.launcherScroll),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll(LAUNCHER_SELECTORS.tile("stream")),
    ).toHaveLength(1);
    expect(
      document
        .querySelector(LAUNCHER_SELECTORS.tile("stream"))
        ?.closest('[data-testid="home-launcher-launcher-page"]'),
    ).not.toBeNull();
  });
});
