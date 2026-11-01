/** Canonical host adapter for the shared startup owner. */
import { canonicalStartupPoll } from "./canonical-startup-host";

export type { PollingBackendDeps } from "@elizaos/ui/startup/coordinator";
export const {
  isTerminalDedicatedCloudAgentErrorState,
  shouldFallBackToLocalOrigin,
  isRecoverableRemoteBase,
  resolveStartupCloudControlPlaneBase,
  runPollingBackend,
} = canonicalStartupPoll;
