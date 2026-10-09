/**
 * Declares the shared shell and outer page-frame contract for every Notes
 * renderer. The inner collection rail owns its separate readable-width policy.
 */

import type { SurfaceManifest } from "@elizaos/core";

export const NOTES_SURFACE = {
  header: "normal",
  // First-party view whose declared capabilities (read, create, update,
  // delete, clear) the agent drives through the mounted view broker; without
  // this grant every non-read-only capability is denied (#31534).
  capabilities: ["agent-surface"],
  layout: {
    kind: "content",
    width: "wide",
    scroll: "view",
    gutter: "standard",
  },
} as const satisfies SurfaceManifest;
