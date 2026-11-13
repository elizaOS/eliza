/** Canonical host adapter for the shared startup owner. */
import { canonicalStartupRestore } from "./canonical-startup-host";

export type {
  RestoringSessionCtx,
  RestoringSessionDeps,
} from "@elizaos/ui/startup/coordinator";
export const {
  reconcileMobileRestoredActiveServer,
  applyRestoredConnection,
  isDesktopEmbeddedApiBase,
  resolveDesktopRestoredTarget,
  canRestoreActiveServer,
  runRestoringSession,
} = canonicalStartupRestore;
