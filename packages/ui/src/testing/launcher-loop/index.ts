/**
 * Public runner for the shared launcher long-loop engine (#12179 WI-5). One
 * seeded fast-check `fc.commands` model over the launcher gesture alphabet
 * (`commands.ts`), driven through a platform `Driver` (`cdp-gestures.ts`),
 * checking every invariant (`invariants.ts`) after each command against a pure
 * model (`model.ts`).
 *
 * `runLauncherLoop(page, options)` is the entry point every platform lane calls:
 * the web / desktop-renderer runners pass a Playwright `Page` (the built-in CDP
 * touch driver is wired up automatically); the Android and iOS lanes pass their
 * own `Driver` via `options.driver`. A failing run throws with the seed and the
 * shrunk command path so the exact gesture sequence replays deterministically.
 */

import fc from "fast-check";
import type { Page } from "playwright";
import {
  CdpTouchDriver,
  type Driver,
  LAUNCHER_LOOP_INIT_SCRIPT,
  LAUNCHER_SELECTORS,
  readTileIds,
} from "./cdp-gestures";
import {
  type CommandWeights,
  DEFAULT_MAX_COMMANDS,
  launcherCommands,
} from "./commands";
import type { InvariantContext } from "./invariants";
import { INITIAL_MODEL_STATE, type LauncherModelState } from "./model";

export type {
  Driver,
  LauncherObservation,
} from "./cdp-gestures";
export {
  CdpTouchDriver,
  LAUNCHER_SELECTORS,
  NOTIFICATION_OPEN_SELECTOR,
} from "./cdp-gestures";
export {
  type CommandWeights,
  DEFAULT_WEIGHTS,
  launcherCommands,
} from "./commands";
export {
  checkInvariants,
  DEFAULT_INVARIANT_CONTEXT,
  type InvariantContext,
} from "./invariants";
export {
  advanceModel,
  INITIAL_MODEL_STATE,
  type LauncherAction,
  type LauncherModelState,
  type LauncherPage,
} from "./model";

export interface RunLauncherLoopOptions {
  /**
   * The gesture driver. Defaults to the CDP-touch web driver over `page`;
   * native lanes (Android/iOS) supply their own here.
   */
  readonly driver?: Driver;
  /** Total number of actions to drive (the loop's budget). Default 500. */
  readonly actions?: number;
  /**
   * Explicit seed for reproducibility. Defaults to `ELIZA_LOOP_SEED` (if set) or
   * a random seed; the resolved seed is always returned and printed on failure.
   */
  readonly seed?: number;
  /** Command family weights (see `DEFAULT_WEIGHTS`). */
  readonly weights?: CommandWeights;
  /** Invariant tuning (CLS budget, transform tolerance). */
  readonly invariantContext?: InvariantContext;
  /**
   * Explicit tile ids to drive taps against. Defaults to reading every
   * `launcher-tile-<id>` from the page.
   */
  readonly tileIds?: readonly string[];
  /**
   * Reset the surface to a known state before the run. Defaults to a script
   * that clears the telemetry ring and returns the rail to the home page.
   */
  readonly resetPage?: (page: Page) => Promise<void>;
}

export interface RunLauncherLoopResult {
  /** The seed that produced this run (feed back via `seed` to replay). */
  readonly seed: number;
  /** Number of actions the model executed. */
  readonly actions: number;
}

/** Default env var carrying an explicit seed for CI reproducibility. */
const SEED_ENV = "ELIZA_LOOP_SEED";

function resolveSeed(explicit: number | undefined): number {
  if (typeof explicit === "number") return explicit;
  const fromEnv = process.env[SEED_ENV];
  if (fromEnv && fromEnv.trim().length > 0) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  // fast-check's own default seed derivation, made explicit so we can print it.
  return Date.now() ^ Math.floor(Math.random() * 0x100000000);
}

/** Clear the telemetry ring + console-error counter and re-home the rail. */
async function defaultResetPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = window as unknown as Record<string, unknown>;
    g.__ELIZA_VIEW_INTERACTION_TELEMETRY__ = [];
    g.__ELIZA_LAUNCHER_LOOP_CONSOLE_ERRORS__ = 0;
    g.__ELIZA_LAUNCHER_LOOP_CLS__ = 0;
  });
  await page
    .locator(LAUNCHER_SELECTORS.surface)
    .first()
    .waitFor({ state: "attached" });
}

/**
 * Run one seeded launcher loop. Resolves with the seed + action count on
 * success; throws with the seed and shrunk command path on the first invariant
 * violation. The command sequence is a single generated run of up to `actions`
 * commands, so `numRuns: 1` keeps the whole budget in one replayable sequence.
 */
export async function runLauncherLoop(
  page: Page,
  options: RunLauncherLoopOptions = {},
): Promise<RunLauncherLoopResult> {
  const actions = options.actions ?? 500;
  const seed = resolveSeed(options.seed);
  const driver = options.driver ?? new CdpTouchDriver(page);

  await page.addInitScript(LAUNCHER_LOOP_INIT_SCRIPT);
  // The init script must be installed before the surface mounts; if the page is
  // already live, install the observers now too (idempotent).
  await page.evaluate(LAUNCHER_LOOP_INIT_SCRIPT);

  const reset = options.resetPage ?? defaultResetPage;
  await reset(page);

  const tileIds = options.tileIds ?? (await readTileIds(page));

  const commands = launcherCommands({
    tileIds,
    weights: options.weights,
    invariantContext: options.invariantContext,
    maxCommands: Math.max(actions, DEFAULT_MAX_COMMANDS),
  });

  try {
    await fc.assert(
      fc.asyncProperty(commands, async (cmds) => {
        await reset(page);
        const setup = (): {
          model: LauncherModelState;
          real: Driver;
        } => ({
          model: { ...INITIAL_MODEL_STATE },
          real: driver,
        });
        await fc.asyncModelRun(setup, cmds);
      }),
      { seed, numRuns: 1, endOnFailure: true },
    );
  } catch (error) {
    // fast-check's top-level message carries the shrunk command path; the
    // specific invariant that fired is on the cause (the error a command threw).
    const summary = error instanceof Error ? error.message : String(error);
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? `\nInvariant: ${error.cause.message}`
        : "";
    throw new Error(
      `launcher loop failed (seed=${seed}). Replay with ${SEED_ENV}=${seed}.\n${summary}${cause}`,
      { cause: error },
    );
  }

  return { seed, actions };
}
