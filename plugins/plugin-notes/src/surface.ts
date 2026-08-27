/**
 * Declares the shared shell and outer page-frame contract for every Notes
 * renderer. The inner collection rail owns its separate readable-width policy.
 */

import type { SurfaceManifest } from "@elizaos/core";

export const NOTES_SURFACE = {
  header: "normal",
  layout: {
    kind: "content",
    width: "wide",
    scroll: "view",
    gutter: "standard",
  },
} as const satisfies SurfaceManifest;
