/**
 * Spatial render context — the small amount of ambient state the primitives
 * need: which modality they are rendering into, and where actions go.
 *
 * The primitives read this via {@link useSpatialContext} so the SAME authored
 * tree renders GUI vs. XR (different cell sizing, larger touch targets) without
 * any per-view branching. The default is `gui` so a primitive used outside a
 * {@link SpatialSurface} still renders sensibly.
 */

import { createContext, useContext } from "react";
import type { SpatialModality } from "./ir.ts";

/** An action raised by a primitive (e.g. a button press). */
export interface SpatialAction {
  type: "press" | "change" | "submit";
  agentId: string;
  value?: string;
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
