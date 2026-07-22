/**
 * Selector regression coverage for the real-browser launcher-loop driver. The
 * fixture intentionally renders an embedded launcher on Home beside the
 * dedicated launcher pane, so gestures must never target the offscreen copy.
 *
 * @vitest-environment jsdom
 */

import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { touchLongPress, touchSwipe, touchTap } from "../real-touch-gestures";
import {
  CdpTouchDriver,
  LAUNCHER_SELECTORS,
  readTileIds,
} from "./cdp-gestures";

vi.mock("../real-touch-gestures", () => ({
  touchLongPress: vi.fn(),
  touchSwipe: vi.fn(),
  touchTap: vi.fn(),
}));

interface DriverPageHarness {
  page: Page;
  button: {
    click: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    isVisible: ReturnType<typeof vi.fn>;
  };
  keyboardPress: ReturnType<typeof vi.fn>;
  scrollIntoViewIfNeeded: ReturnType<typeof vi.fn>;
  waitForFunction: ReturnType<typeof vi.fn>;
}

function mountLauncherSurface(page = "home"): void {
  document.body.innerHTML = `
    <main data-testid="home-launcher-surface" data-page="${page}" style="width: 390px">
      <div data-testid="home-launcher-rail" style="transform: matrix(1, 0, 0, 1, 0, 0)"></div>
      <span data-testid="home-launcher-page-probe">${page}</span>
      <section data-testid="home-launcher-home-page"></section>
      <section data-testid="home-launcher-launcher-page">
        <div data-testid="launcher-page-window">
          <button data-testid="launcher-tile-stream">Stream</button>
        </div>
      </section>
    </main>
  `;
  const rail = document.querySelector(LAUNCHER_SELECTORS.rail);
  const surface = document.querySelector(LAUNCHER_SELECTORS.surface);
  Object.defineProperty(rail, "getAnimations", {
    configurable: true,
    value: () => [{ playState: "finished" }],
  });
  Object.defineProperty(rail, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, width: 780 }),
  });
  Object.defineProperty(surface, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, width: 390 }),
  });
}

function makeDriverPage(dataPages: string[] = ["home"]): DriverPageHarness {
  const button = {
    click: vi.fn(async () => undefined),
    count: vi.fn(async () => 1),
    isVisible: vi.fn(async () => true),
  };
  const scrollIntoViewIfNeeded = vi.fn(async () => undefined);
  const keyboardPress = vi.fn(async () => undefined);
  const getAttribute = vi.fn(async () => dataPages.shift() ?? "home");
  const waitForFunction = vi.fn(
    async (
      predicate: (selectors: { rail: string; surface: string }) => boolean,
      selectors: { rail: string; surface: string },
    ) => {
      expect(predicate(selectors)).toBe(true);
    },
  );
  const locator = vi.fn((selector: string) => ({
    first: () =>
      selector === LAUNCHER_SELECTORS.surface
        ? { getAttribute }
        : selector === LAUNCHER_SELECTORS.railPrevButton ||
            selector === LAUNCHER_SELECTORS.railNextButton
          ? button
          : { scrollIntoViewIfNeeded },
  }));
  const page = {
    keyboard: { press: keyboardPress },
    locator,
    waitForFunction,
    evaluate: async <T>(callback: (arg?: unknown) => T, arg?: unknown) =>
      callback(arg),
  } as unknown as Page;
  return {
    page,
    button,
    keyboardPress,
    scrollIntoViewIfNeeded,
    waitForFunction,
  };
}

beforeEach(() => {
  mountLauncherSurface();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("drives rail, tile, grid, widget, and keyboard gestures through the scoped selectors", async () => {
    const harness = makeDriverPage(["home", "launcher"]);
    const driver = new CdpTouchDriver(harness.page, {
      commitDistance: 300,
      rejectDistance: 20,
    });

    await driver.railSwipe("left", true);
    expect(touchSwipe).toHaveBeenCalledWith(
      harness.page,
      LAUNCHER_SELECTORS.homePage,
      -300,
      0,
      { steps: 10, stepDelayMs: 16 },
    );

    await driver.railEdgeButton("prev");
    expect(harness.button.click).toHaveBeenCalledOnce();

    await driver.tapTile("stream");
    expect(harness.scrollIntoViewIfNeeded).toHaveBeenCalled();
    expect(touchTap).toHaveBeenCalledWith(
      harness.page,
      LAUNCHER_SELECTORS.tile("stream"),
    );

    await driver.longPressTile("stream");
    expect(touchLongPress).toHaveBeenCalledWith(
      harness.page,
      LAUNCHER_SELECTORS.tile("stream"),
      650,
    );

    await driver.scrollGrid(80);
    await driver.scrollWidgets(-40);
    expect(touchSwipe).toHaveBeenCalledWith(
      harness.page,
      LAUNCHER_SELECTORS.launcherScroll,
      0,
      -80,
      { steps: 8, stepDelayMs: 1 },
    );
    expect(touchSwipe).toHaveBeenCalledWith(
      harness.page,
      LAUNCHER_SELECTORS.homeScreen,
      0,
      40,
      { steps: 8, stepDelayMs: 1 },
    );

    await driver.tabFocus();
    expect(harness.keyboardPress).toHaveBeenCalledWith("Tab");
    expect(harness.waitForFunction).toHaveBeenCalled();
  });

  it("handles rejected navigation, absent edge controls, and a failed best-effort tile scroll", async () => {
    const harness = makeDriverPage(["home", "home"]);
    const driver = new CdpTouchDriver(harness.page);

    await driver.railSwipe("right", false);
    expect(touchSwipe).toHaveBeenCalledWith(
      harness.page,
      LAUNCHER_SELECTORS.launcherPage,
      24,
      0,
      { steps: 10, stepDelayMs: 16 },
    );

    harness.button.count.mockResolvedValueOnce(0);
    await driver.railEdgeButton("next");
    harness.button.count.mockResolvedValueOnce(1);
    harness.button.isVisible.mockResolvedValueOnce(false);
    await driver.railEdgeButton("next");
    expect(harness.button.click).not.toHaveBeenCalled();

    harness.scrollIntoViewIfNeeded.mockRejectedValueOnce(
      new Error("detached during centering"),
    );
    await driver.tapTile("stream");
    expect(touchTap).toHaveBeenCalledOnce();
  });

  it("observes the live launcher DOM and ignores descendant animations while settling", async () => {
    const harness = makeDriverPage();
    const rail = document.querySelector(LAUNCHER_SELECTORS.rail);
    const child = document.createElement("span");
    rail?.append(child);
    Object.defineProperty(child, "getAnimations", {
      configurable: true,
      value: () => [{ playState: "running" }],
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    Object.assign(window, {
      __ELIZA_VIEW_INTERACTION_TELEMETRY__: [
        { action: "launch" },
        { action: "dismiss" },
      ],
      __ELIZA_LAUNCHER_LOOP_CLS__: 0.02,
      __ELIZA_LAUNCHER_LOOP_CONSOLE_ERRORS__: 1,
    });

    const observation = await new CdpTouchDriver(harness.page).observe();
    expect(observation).toMatchObject({
      dataPage: "home",
      probeText: "home",
      railTransformX: 0,
      launchCount: 1,
      viewportWidth: 390,
      layoutShiftScore: 0.02,
      consoleErrorCount: 1,
    });
  });
});
