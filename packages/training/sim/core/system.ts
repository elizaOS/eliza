/**
 * defineSystem — functional definer for BabylonSystem (UnJS-style).
 */

import type { BabylonSystem } from "./types";

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
