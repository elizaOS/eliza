/**
 * defineSystem — functional definer for BabylonSystem (UnJS-style).
 */

import type { BabylonSystem, SystemTickResult } from "./types";

export type SystemDefinition = Omit<
  BabylonSystem,
  "register" | "onTick" | "destroy"
> & {
  register?: BabylonSystem["register"];
  onTick: BabylonSystem["onTick"];
  destroy?: BabylonSystem["destroy"];
};

export function defineSystem(def: SystemDefinition): BabylonSystem {
  return def;
}

/**
 * @deprecated Use `defineSystem()` instead.
 */
export abstract class AbstractBabylonSystem implements BabylonSystem {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly phase: BabylonSystem["phase"];

  readonly dependencies?: string[];
  readonly skipDeadlineCheck?: boolean;
  readonly intervals?: BabylonSystem["intervals"];

  async register(
    _ctx: Parameters<NonNullable<BabylonSystem["register"]>>[0],
  ): Promise<void> {}

  abstract onTick(
    ctx: Parameters<BabylonSystem["onTick"]>[0],
  ): Promise<SystemTickResult>;

  async destroy(): Promise<void> {}
}
