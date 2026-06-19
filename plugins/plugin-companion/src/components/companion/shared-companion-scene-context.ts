/**
 * Shared context for the companion scene.
 *
 * Extracted into its own module so consumers can import
 * `useSharedCompanionScene` without pulling in the heavy 3D stack
 * (three / @pixiv/three-vrm) that lives in
 * CompanionSceneHost.
 */
import { createContext, useContext } from "react";

export const SharedCompanionSceneContext = createContext(false);

export function useSharedCompanionScene(): boolean {
  return useContext(SharedCompanionSceneContext);
}
