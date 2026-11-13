/** Canonical host adapter for the shared startup owner. */
import { canonicalStartup } from "./canonical-startup-host";

export type {
  StartupCoordinatorDeps,
  StartupCoordinatorHandle,
} from "@elizaos/ui/startup/coordinator";
export const {
  recoverTerminalStartupError,
  surfaceUnexpectedStartupRunnerError,
  useStartupCoordinator,
} = canonicalStartup;
