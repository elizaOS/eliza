/**
 * Compatibility seam for the retired terminal adapter.
 *
 * `viewType: "tui"` remains a public contract so older payloads and future
 * reintroductions can compile, but this package no longer ships a concrete
 * alternate renderer or plugin registry.
 */

import type { ReactElement } from "react";

export interface SpatialTuiComponentOptions {
  onChange?: () => void;
}

function unsupported(): never {
  throw new Error("The terminal adapter is not shipped in this build.");
}

export function createSpatialTuiComponent(
  _render: () => ReactElement,
  _options?: SpatialTuiComponentOptions,
): never {
  unsupported();
}

export function getSpatialViewThunk(_id: string): undefined {
  return undefined;
}
