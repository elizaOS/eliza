/**
 * Engine self-check for the launcher long-loop (#12179 WI-5). Runs the real
 * fast-check command loop against an in-memory `FakeDriver` that faithfully
 * mirrors the launcher state machine — no browser — so the model, commands, and
 * invariants are exercised end-to-end deterministically. A second suite injects
 * a known gesture bug into the fake surface and asserts the loop catches it with
 * a seeded, shrunk command path (the reproducibility contract).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Driver, LauncherObservation } from "./cdp-gestures";
import { launcherCommands } from "./commands";
import {
  advanceModel,
  INITIAL_MODEL_STATE,
  type LauncherModelState,
} from "./model";

const TILE_IDS = ["chat", "wallet", "settings"] as const;
const VIEWPORT_WIDTH = 390;

interface FakeSurfaceOptions {
  /** Injected bug: a committed left rail swipe from home fails to navigate. */
  readonly dropCommittedLeftSwipe?: boolean;
  /** Injected bug: a tile tap fires a second ghost launch. */
  readonly ghostLaunchOnTap?: boolean;
  /** Injected bug: the rail parks at the wrong transform on the launcher page. */
  readonly wrongTransformOnLauncher?: boolean;
}

/**
 * An in-memory launcher surface driven by the same `Driver` interface the real
 * CDP driver implements. Its `observe()` derives a `LauncherObservation` from
 * its own state exactly as a correct launcher would render it, so the loop's
 * invariants pass on the clean fake and fail precisely on an injected bug.
 */
class FakeSurface implements Driver {
  page: "home" | "launcher" = "home";
  notificationOpen = false;
  launchCount = 0;
  focusInInert = false;

  constructor(private readonly bugs: FakeSurfaceOptions = {}) {}

  async railSwipe(
    direction: "left" | "right",
    committed: boolean,
  ): Promise<void> {
    if (!committed) return;
    if (direction === "left" && this.page === "home") {
      if (this.bugs.dropCommittedLeftSwipe) return;
      this.goTo("launcher");
    } else if (direction === "right" && this.page === "launcher") {
      this.goTo("home");
    }
  }

  async railEdgeButton(direction: "prev" | "next"): Promise<void> {
    if (direction === "next" && this.page === "home") this.goTo("launcher");
    else if (direction === "prev" && this.page === "launcher")
      this.goTo("home");
  }

  async tapTile(_tileId: string): Promise<void> {
    if (this.page !== "launcher") return;
    this.launchCount += 1;
    if (this.bugs.ghostLaunchOnTap) this.launchCount += 1;
  }

  async longPressTile(_tileId: string): Promise<void> {
    // Inert: no edit mode, no ghost launch.
  }

  async scrollGrid(_dy: number): Promise<void> {}
  async scrollWidgets(_dy: number): Promise<void> {}

  async notificationPull(committed: boolean): Promise<void> {
    if (this.page !== "home" || !committed) return;
    this.notificationOpen = true;
  }

  async dismissNotification(): Promise<void> {
    this.notificationOpen = false;
  }

  async tabFocus(): Promise<void> {
    // Focus is always pulled into the visible half — never the inert one.
    this.focusInInert = false;
  }

  async observe(): Promise<LauncherObservation> {
    const pageIndex = this.page === "launcher" ? 1 : 0;
    const transform =
      this.bugs.wrongTransformOnLauncher && this.page === "launcher"
        ? 0
        : -pageIndex * VIEWPORT_WIDTH;
    return {
      dataPage: this.page,
      probeText: `home-launcher-page:${this.page}`,
      railTransformX: transform,
      homeInert: this.page !== "home",
      launcherInert: this.page !== "launcher",
      activeElementInInert: this.focusInInert,
      launchCount: this.launchCount,
      notificationOpen: this.notificationOpen,
      viewportWidth: VIEWPORT_WIDTH,
      blueSampleCount: 0,
      layoutShiftScore: 0,
      consoleErrorCount: 0,
    };
  }

  private goTo(page: "home" | "launcher"): void {
    this.page = page;
    this.notificationOpen = false;
    this.focusInInert = false;
  }
}

/** Full failure text: fast-check's shrunk-path message + the invariant cause. */
function failureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `\n${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

async function runLoop(
  surface: FakeSurface,
  opts: { seed: number; maxCommands: number; numRuns: number },
): Promise<void> {
  const commands = launcherCommands({
    tileIds: [...TILE_IDS],
    maxCommands: opts.maxCommands,
  });
  await fc.assert(
    fc.asyncProperty(commands, async (cmds) => {
      const generated = Array.from(cmds);
      expect(generated).toHaveLength(opts.maxCommands);
      surface.page = "home";
      surface.notificationOpen = false;
      surface.launchCount = 0;
      surface.focusInInert = false;
      const setup = (): { model: LauncherModelState; real: Driver } => ({
        model: { ...INITIAL_MODEL_STATE },
        real: surface,
      });
      await fc.asyncModelRun(setup, generated);
    }),
    { seed: opts.seed, numRuns: opts.numRuns, endOnFailure: true },
  );
}

describe("launcher-loop model", () => {
  it("advanceModel commits a left rail swipe home→launcher only when committed", () => {
    const home = INITIAL_MODEL_STATE;
    const rejected = advanceModel(home, {
      kind: "rail-swipe",
      direction: "left",
      committed: false,
    });
    expect(rejected.page).toBe("home");

    const committed = advanceModel(home, {
      kind: "rail-swipe",
      direction: "left",
      committed: true,
    });
    expect(committed.page).toBe("launcher");
    expect(committed.focusZone).toBe("launcher");
  });

  it("a tile tap only launches from the launcher half", () => {
    const home = INITIAL_MODEL_STATE;
    expect(
      advanceModel(home, { kind: "tile-tap", tileId: "chat" }).launchCount,
    ).toBe(0);
    const onLauncher = advanceModel(home, {
      kind: "rail-swipe",
      direction: "left",
      committed: true,
    });
    expect(
      advanceModel(onLauncher, { kind: "tile-tap", tileId: "chat" })
        .launchCount,
    ).toBe(1);
  });

  it("a committed notification pull opens only on the home half", () => {
    const home = INITIAL_MODEL_STATE;
    expect(
      advanceModel(home, { kind: "notification-pull", committed: true })
        .notificationOpen,
    ).toBe(true);
    const onLauncher = advanceModel(home, {
      kind: "rail-swipe",
      direction: "left",
      committed: true,
    });
    expect(
      advanceModel(onLauncher, { kind: "notification-pull", committed: true })
        .notificationOpen,
    ).toBe(false);
  });

  it("a rail transition closes an open notification center", () => {
    const opened = advanceModel(INITIAL_MODEL_STATE, {
      kind: "notification-pull",
      committed: true,
    });
    expect(opened.notificationOpen).toBe(true);
    const afterSwipe = advanceModel(opened, {
      kind: "rail-swipe",
      direction: "left",
      committed: true,
    });
    expect(afterSwipe.notificationOpen).toBe(false);
  });
});

describe("launcher-loop engine self-check", () => {
  it("runs a 50-command loop against a correct fake surface with no violations", async () => {
    const surface = new FakeSurface();
    await expect(
      runLoop(surface, { seed: 1234, maxCommands: 50, numRuns: 1 }),
    ).resolves.toBeUndefined();
  });

  it("holds across many seeds (multi-run property)", async () => {
    const surface = new FakeSurface();
    await expect(
      runLoop(surface, { seed: 99, maxCommands: 30, numRuns: 25 }),
    ).resolves.toBeUndefined();
  });
});

describe("launcher-loop injected-failure detection", () => {
  it("catches a dropped committed left-swipe with a shrunk repro", async () => {
    const surface = new FakeSurface({ dropCommittedLeftSwipe: true });
    let caught: unknown;
    try {
      await runLoop(surface, { seed: 7, maxCommands: 40, numRuns: 40 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = failureText(caught);
    // fast-check reports the seed and the shrunk counterexample command path.
    expect(message).toMatch(/seed/i);
    expect(message).toMatch(/counterexample|railSwipe/i);
    // The invariant that fired is the page/probe/transform mismatch.
    expect(message).toMatch(/data-page|page-probe|transformX/);
  });

  it("catches a ghost-launch tap bug (telemetry launch-count invariant)", async () => {
    const surface = new FakeSurface({ ghostLaunchOnTap: true });
    let caught: unknown;
    try {
      await runLoop(surface, { seed: 3, maxCommands: 40, numRuns: 40 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(failureText(caught)).toMatch(/launch count|ghost or dropped/i);
  });

  it("catches a wrong at-rest transform (transform-at-rest invariant)", async () => {
    const surface = new FakeSurface({ wrongTransformOnLauncher: true });
    let caught: unknown;
    try {
      await runLoop(surface, { seed: 5, maxCommands: 40, numRuns: 40 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(failureText(caught)).toMatch(/transformX/);
  });
});
