/** Declares the shared shell and responsive layout contract for every Notes renderer. */

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
