/**
 * Spatial render context — the small amount of ambient state the primitives
 * need: which modality they are rendering into, and where actions go.
 *
 * The primitives read this via {@link useSpatialContext} so the same authored
 * tree can be interpreted by the shipped DOM renderer and any future adapters
 * without per-view branching. The default is `gui` so a primitive used outside a
 * {@link SpatialSurface} still renders sensibly.
 */

import { createContext, useContext } from "react";
import type { SpatialModality } from "./ir.ts";

/**
 * An action raised by a primitive (a button press, a field change) or by a
 * future spatial host. `move` carries a panel's new world position so that host
 * can persist placement; the others carry the changed `value` where relevant.
 */
export interface SpatialAction {
  type: "press" | "change" | "submit" | "move";
  agentId: string;
  value?: string;
  /** For `move`: the panel's new world-space position (metres). */
  position?: { x: number; y: number; z: number };
}

export interface SpatialContextValue {
  modality: SpatialModality;
  /** Route a primitive action to the host (agent surface, view interact, …). */
  dispatch?: (action: SpatialAction) => void;
}

const SpatialContext = createContext<SpatialContextValue>({ modality: "gui" });

export const SpatialContextProvider = SpatialContext.Provider;

export function useSpatialContext(): SpatialContextValue {
  return useContext(SpatialContext);
}
