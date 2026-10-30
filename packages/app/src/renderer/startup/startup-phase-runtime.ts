/** Canonical host adapter for the shared startup owner. */
import { canonicalStartupRuntime } from "./canonical-startup-host";

export type { StartingRuntimeDeps } from "@elizaos/ui/startup/coordinator";
export const { runStartingRuntime } = canonicalStartupRuntime;
