/**
 * The fast-check command alphabet for the launcher loop. Each command is an
 * `AsyncCommand<LauncherModelState, Driver>`: `check(model)` decides whether the
 * command is applicable in the current model state, `run(model, driver)`
 * realizes the gesture through the driver, advances the model, then asserts
 * every invariant against a fresh observation (`invariants.ts`).
 *
 * The commands ARE the §D `[L]` alphabet — rail swipes (committed + rejected,
 * both directions), edge-button clicks, tile taps + long-presses, grid /
 * widget scrolls, notification pulls (committed + rejected) + dismiss, and a
 * Tab-focus probe. `launcherCommands()` returns the weighted arbitrary
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
  check(model: Readonly<LauncherModelState>): boolean {
    // A committed swipe only makes sense where a transition exists; a rejected
    // swipe is valid anywhere (it must settle back and change nothing).
    if (!this.committed) return true;
    return this.direction === "left" ? canGoNext(model) : canGoPrev(model);
  }
  async drive(_model: LauncherModelState, driver: Driver): Promise<void> {
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
  check(model: Readonly<LauncherModelState>): boolean {
    return this.direction === "next" ? canGoNext(model) : canGoPrev(model);
  }
  async drive(_model: LauncherModelState, driver: Driver): Promise<void> {
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
  check(model: Readonly<LauncherModelState>): boolean {
    return model.page === "launcher";
  }
  async drive(_model: LauncherModelState, driver: Driver): Promise<void> {
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
  check(model: Readonly<LauncherModelState>): boolean {
    return model.page === "launcher";
  }
  async drive(_model: LauncherModelState, driver: Driver): Promise<void> {
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
  check(model: Readonly<LauncherModelState>): boolean {
    return model.page === "launcher";
  }
  async drive(_model: LauncherModelState, driver: Driver): Promise<void> {
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
  check(model: Readonly<LauncherModelState>): boolean {
    return model.page === "home";
  }
  async drive(_model: LauncherModelState, driver: Driver): Promise<void> {
    await driver.scrollWidgets(this.dy);
  }
  toString(): string {
    return `widgetScroll(${this.dy})`;
  }
}

class NotificationPullCommand extends LauncherCommandBase {
  constructor(
    ctx: InvariantContext | undefined,
    private readonly committed: boolean,
  ) {
    super(ctx);
  }
  action(): LauncherAction {
    return { kind: "notification-pull", committed: this.committed };
  }
  check(model: Readonly<LauncherModelState>): boolean {
    return model.page === "home" && !model.notificationOpen;
  }
  async drive(_model: LauncherModelState, driver: Driver): Promise<void> {
    await driver.notificationPull(this.committed);
  }
  toString(): string {
    return `notificationPull(${this.committed ? "commit" : "reject"})`;
  }
}

class NotificationDismissCommand extends LauncherCommandBase {
  action(): LauncherAction {
    return { kind: "notification-dismiss" };
  }
  check(model: Readonly<LauncherModelState>): boolean {
    return model.notificationOpen;
  }
  async drive(_model: LauncherModelState, driver: Driver): Promise<void> {
    await driver.dismissNotification();
  }
  toString(): string {
    return "notificationDismiss";
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
  readonly notificationPull: number;
  readonly notificationDismiss: number;
  readonly tabFocus: number;
}

export const DEFAULT_WEIGHTS: CommandWeights = {
  railSwipe: 8,
  railEdgeButton: 2,
  tileTap: 5,
  tileLongPress: 2,
  gridScroll: 2,
  widgetScroll: 2,
  notificationPull: 3,
  notificationDismiss: 2,
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
    {
      weight: w.notificationPull,
      arbitrary: fc
        .boolean()
        .map((committed) => new NotificationPullCommand(ctx, committed)),
    },
    {
      weight: w.notificationDismiss,
      arbitrary: fc.constant(new NotificationDismissCommand(ctx)),
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

  // `fc.commands` takes an array of command arbitraries; the weighting is folded
  // into a single `fc.oneof` so the whole alphabet is one weighted draw.
  const [first, ...rest] = entries;
  return fc.commands([fc.oneof(first, ...rest)], {
    size: "+1",
    maxCommands: options.maxCommands ?? DEFAULT_MAX_COMMANDS,
  });
}

/** Default ceiling on commands per generated sequence. */
export const DEFAULT_MAX_COMMANDS = 60;
