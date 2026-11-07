/** Canonical host adapter for the shared startup owner. */
import { canonicalStartupHydration } from "./canonical-startup-host";

export type {
  HydratingDeps,
  ReadyPhaseDeps,
} from "@elizaos/ui/startup/coordinator";
export const { runHydrating, bindReadyPhase } = canonicalStartupHydration;
