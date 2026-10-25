/**
 * The fast-check command alphabet for the launcher loop. Each command is an
 * `AsyncCommand<LauncherModelState, Driver>`: `check(model)` decides whether the
 * command is applicable in the current model state, `run(model, driver)`
 * realizes the gesture through the driver, advances the model, then asserts
 * every invariant against a fresh observation (`invariants.ts`).
 *
 * The commands ARE the §D `[L]` alphabet — rail swipes (committed + rejected,
 * both directions), edge-button clicks, tile taps + long-presses, grid /
 * widget scrolls (the home half's scroll covers the pinned notification
 * center card too), and a Tab-focus probe. `launcherCommands()` returns the
 * weighted arbitrary
 * `fc.commands` consumes; weights bias the loop toward the high-signal gestures
 * (swipes, taps) while still exercising the edges.
 */

import fc from "fast-check";
import type { Driver } from "./cdp-gestures";
import { checkInvariants, type InvariantContext } from "./invariants";
import {
  advanceModel,
  canGoNext,
  canGoPrev,
  type LauncherAction,
  type LauncherModelState,
} from "./model";

export type LauncherCommand = fc.AsyncCommand<LauncherModelState, Driver>;

/** After the driver acts + the model advances, verify the real surface. */
async function assertInvariants(
  model: LauncherModelState,
  driver: Driver,
  ctx: InvariantContext | undefined,
): Promise<void> {
  const observed = await driver.observe();
  const failures = checkInvariants(model, observed, ctx);
  if (failures.length > 0) {
    throw new Error(`invariant violation(s):\n  - ${failures.join("\n  - ")}`);
  }
}

/**
 * A command that advances the model in place and re-checks invariants. The
 * model object fast-check threads is mutated so the next command sees the new
 * state (fast-check clones the model between shrink attempts via
 * `structuredClone`, keeping shrinking sound).
 */
abstract class LauncherCommandBase implements LauncherCommand {
  constructor(protected readonly ctx: InvariantContext | undefined) {}

  abstract action(model: LauncherModelState): LauncherAction;
  abstract check(model: Readonly<LauncherModelState>): boolean;
  abstract drive(model: LauncherModelState, driver: Driver): Promise<void>;
  abstract toString(): string;

  async run(model: LauncherModelState, driver: Driver): Promise<void> {
    await this.drive(model, driver);
    const next = advanceModel(model, this.action(model));
    Object.assign(model, next);
    await assertInvariants(model, driver, this.ctx);
  }
}

class RailSwipeCommand extends LauncherCommandBase {
  constructor(
    ctx: InvariantContext | undefined,
    private readonly direction: "left" | "right",
    private readonly committed: boolean,
  ) {
    super(ctx);
  }
  action(): LauncherAction {
    return {
      kind: "rail-swipe",
      direction: this.direction,
      committed: this.committed,
    };
  }
  check(): boolean {
    return true;
  }
  async drive(model: LauncherModelState, driver: Driver): Promise<void> {
    // `fc.commands` precondition skips make a "50 command" loop silently run
    // fewer actions. Keep every generated command executable; when a committed
    // swipe has no destination, it is a safe no-op attempt and the invariants
    // still prove the surface stayed put.
    if (
      this.committed &&
      !(this.direction === "left" ? canGoNext(model) : canGoPrev(model))
    ) {
      return;
    }
    await driver.railSwipe(this.direction, this.committed);
  }
  toString(): string {
    return `railSwipe(${this.direction},${this.committed ? "commit" : "reject"})`;
  }
}

class RailEdgeButtonCommand extends LauncherCommandBase {
  constructor(
    ctx: InvariantContext | undefined,
    private readonly direction: "prev" | "next",
  ) {
    super(ctx);
  }
  action(): LauncherAction {
    return { kind: "rail-edge-button", direction: this.direction };
  }
  check(): boolean {
    return true;
  }
  async drive(model: LauncherModelState, driver: Driver): Promise<void> {
    if (!(this.direction === "next" ? canGoNext(model) : canGoPrev(model))) {
      return;
    }
    await driver.railEdgeButton(this.direction);
  }
  toString(): string {
    return `railEdgeButton(${this.direction})`;
  }
}

class TileTapCommand extends LauncherCommandBase {
  constructor(
    ctx: InvariantContext | undefined,
    private readonly tileId: string,
  ) {
    super(ctx);
  }
  action(): LauncherAction {
    return { kind: "tile-tap", tileId: this.tileId };
  }
  check(): boolean {
    return true;
  }
  async drive(model: LauncherModelState, driver: Driver): Promise<void> {
    if (model.page !== "launcher") return;
    await driver.tapTile(this.tileId);
  }
  toString(): string {
    return `tileTap(${this.tileId})`;
  }
}

class TileLongPressCommand extends LauncherCommandBase {
  constructor(
    ctx: InvariantContext | undefined,
    private readonly tileId: string,
  ) {
    super(ctx);
  }
  action(): LauncherAction {
    return { kind: "tile-long-press", tileId: this.tileId };
  }
  check(): boolean {
    return true;
  }
  async drive(model: LauncherModelState, driver: Driver): Promise<void> {
    if (model.page !== "launcher") return;
    await driver.longPressTile(this.tileId);
  }
  toString(): string {
    return `tileLongPress(${this.tileId})`;
  }
}

class GridScrollCommand extends LauncherCommandBase {
  constructor(
    ctx: InvariantContext | undefined,
    private readonly dy: number,
  ) {
    super(ctx);
  }
  action(): LauncherAction {
    return { kind: "grid-scroll", dy: this.dy };
  }
  check(): boolean {
    return true;
  }
  async drive(model: LauncherModelState, driver: Driver): Promise<void> {
    if (model.page !== "launcher") return;
    await driver.scrollGrid(this.dy);
  }
  toString(): string {
    return `gridScroll(${this.dy})`;
  }
}

class WidgetScrollCommand extends LauncherCommandBase {
  constructor(
    ctx: InvariantContext | undefined,
    private readonly dy: number,
  ) {
    super(ctx);
  }
  action(): LauncherAction {
    return { kind: "vertical-widget-scroll", dy: this.dy };
  }
  check(): boolean {
    return true;
  }
  async drive(model: LauncherModelState, driver: Driver): Promise<void> {
    if (model.page !== "home") return;
    await driver.scrollWidgets(this.dy);
  }
  toString(): string {
    return `widgetScroll(${this.dy})`;
  }
}

class TabFocusCommand extends LauncherCommandBase {
  action(): LauncherAction {
    return { kind: "tab-focus" };
  }
  check(): boolean {
    return true;
  }
  async drive(_model: LauncherModelState, driver: Driver): Promise<void> {
    await driver.tabFocus();
  }
  toString(): string {
    return "tabFocus";
  }
}

/** Relative selection weights per command family. Higher = more frequent. */
export interface CommandWeights {
  readonly railSwipe: number;
  readonly railEdgeButton: number;
  readonly tileTap: number;
  readonly tileLongPress: number;
  readonly gridScroll: number;
  readonly widgetScroll: number;
  readonly tabFocus: number;
}

export const DEFAULT_WEIGHTS: CommandWeights = {
  railSwipe: 8,
  railEdgeButton: 2,
  tileTap: 5,
  tileLongPress: 2,
  gridScroll: 2,
  widgetScroll: 3,
  tabFocus: 2,
};

export interface CommandsOptions {
  /** Tile ids the launcher exposes; tile commands pick from these. */
  readonly tileIds: readonly string[];
  readonly weights?: CommandWeights;
  readonly invariantContext?: InvariantContext;
  /** Max commands per generated sequence (the loop's action budget). */
  readonly maxCommands?: number;
}

/**
 * The weighted command arbitrary `fc.commands` consumes. Each family expands to
 * its variants (both swipe directions × commit/reject, each tile id) so the
 * generator can reach every gesture while the weights bias sampling toward the
 * high-signal ones. Empty `tileIds` simply omits the tile commands.
 */
export function launcherCommands(
  options: CommandsOptions,
): fc.Arbitrary<Iterable<LauncherCommand>> {
  const w = options.weights ?? DEFAULT_WEIGHTS;
  const ctx = options.invariantContext;
  const tileIds = options.tileIds.length > 0 ? [...options.tileIds] : [];

  const entries: {
    weight: number;
    arbitrary: fc.Arbitrary<LauncherCommand>;
  }[] = [
    {
      weight: w.railSwipe,
      arbitrary: fc
        .tuple(fc.constantFrom("left", "right"), fc.boolean())
        .map(
          ([direction, committed]) =>
            new RailSwipeCommand(ctx, direction as "left" | "right", committed),
        ),
    },
    {
      weight: w.railEdgeButton,
      arbitrary: fc
        .constantFrom("prev", "next")
        .map((d) => new RailEdgeButtonCommand(ctx, d as "prev" | "next")),
    },
    {
      weight: w.gridScroll,
      arbitrary: fc
        .integer({ min: 40, max: 320 })
        .map((dy) => new GridScrollCommand(ctx, dy)),
    },
    {
      weight: w.widgetScroll,
      arbitrary: fc
        .integer({ min: 40, max: 320 })
        .map((dy) => new WidgetScrollCommand(ctx, dy)),
    },
    { weight: w.tabFocus, arbitrary: fc.constant(new TabFocusCommand(ctx)) },
  ];

  if (tileIds.length > 0) {
    entries.push({
      weight: w.tileTap,
      arbitrary: fc
        .constantFrom(...tileIds)
        .map((id) => new TileTapCommand(ctx, id)),
    });
    entries.push({
      weight: w.tileLongPress,
      arbitrary: fc
        .constantFrom(...tileIds)
        .map((id) => new TileLongPressCommand(ctx, id)),
    });
  }

  // Keep the generated sequence exact-length. `fc.commands({ maxCommands })`
  // generates "up to" maxCommands, which made a requested 50/500-action loop
  // silently run much shorter while still reporting the requested count.
  const [first, ...rest] = entries;
  return fc.array(fc.oneof(first, ...rest), {
    minLength: options.maxCommands ?? DEFAULT_MAX_COMMANDS,
    maxLength: options.maxCommands ?? DEFAULT_MAX_COMMANDS,
  });
}

/** Default ceiling on commands per generated sequence. */
export const DEFAULT_MAX_COMMANDS = 60;
