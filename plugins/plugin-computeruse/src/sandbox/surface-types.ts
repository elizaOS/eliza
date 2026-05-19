/**
 * Re-exports of the shared CUA surface types the driver layer consumes. Kept
 * separate from `./types.ts` to keep the sandbox barrel free of churn when
 * upstream `../types.ts` evolves.
 */

export type {
  FileActionResult,
  ScreenRegion,
  TerminalActionResult,
  WindowInfo,
} from "../types.js";

/**
 * Subset of `ProcessInfo` exposed across the driver boundary. The full type
 * lives in `platform/process-list.ts` which depends on host-only modules; we
 * deliberately keep the sandbox surface minimal so backends don't have to
 * reproduce any host-only fields.
 */
export interface ProcessInfoLite {
  pid: number;
  name: string;
}
