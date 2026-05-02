// Module augmentation for @elizaos/core Action type to add Eliza-specific fields.
import type { Action } from "@elizaos/core";

declare module "@elizaos/core" {
  interface Action {
    /** When true, suppresses the post-action continuation prompt. */
    suppressPostActionContinuation?: boolean;
  }
}

export type { Action };
