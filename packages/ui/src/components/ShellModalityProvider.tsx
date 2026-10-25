/**
 * ShellModalityProvider (#9946) — the single shell-level owner of the modality
 * contract. The GUI shell (`packages/app`) mounts this once; it sets the
 * shell-level modality so every leaf's `detectDomModality()` reads one
 * authoritative source instead of each re-guessing per-leaf. Future adapters can
 * set their own modality through the same retained contract.
 */

import { type ReactNode, useEffect } from "react";
import { setShellModality } from "../spatial/dom.tsx";
import type { SpatialModality } from "../spatial/ir.ts";

export function ShellModalityProvider({
  modality = "gui",
  children,
}: {
  modality?: SpatialModality;
  children: ReactNode;
}): React.JSX.Element {
  useEffect(() => setShellModality(modality), [modality]);
  return <>{children}</>;
}
