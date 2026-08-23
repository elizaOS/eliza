/** Defines durable command records and the truthful incremental synthetic-world capability surface. */

import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";

export const SYNTHETIC_WORLD_COMMAND_VERSION = 1 as const;

export type SyntheticJson =
  | null
  | boolean
  | number
  | string
  | SyntheticJson[]
  | { [key: string]: SyntheticJson };

export type SyntheticCommandPhase =
  | "OWNED"
  | "EXECUTING"
  | "COMMITTED"
  | "SUCCEEDED"
  | "FAILED"
  | "DIRTY";

export type SyntheticCommandOutcome =
  | "PENDING"
  | "KNOWN_SUCCESS"
  | "KNOWN_FAILURE"
  | "UNKNOWN";

export interface SyntheticWorldCommand {
  version: typeof SYNTHETIC_WORLD_COMMAND_VERSION;
  namespace: string;
  generation: number;
  commandId: string;
  type: string;
  payload: SyntheticJson;
}

export interface SyntheticCommandRecord {
  version: typeof SYNTHETIC_WORLD_COMMAND_VERSION;
  namespace: string;
  commandId: string;
  generation: number;
  type: string;
  payloadHash: string;
  payload: SyntheticJson;
  phase: SyntheticCommandPhase;
  outcome: SyntheticCommandOutcome;
  result: SyntheticJson | null;
  error: { code: string; message: string } | null;
  executionToken: string | null;
  createdAt: string;
  heartbeatAt: string;
  updatedAt: string;
  revision: number;
}

export interface SyntheticCommandExecution {
  record: SyntheticCommandRecord;
  result: SyntheticJson;
  replayed: boolean;
}

export interface SyntheticCommandRecovery {
  retryableCommandIds: string[];
  failedCommandIds: string[];
  dirtyCommandIds: string[];
  activeCommandIds: string[];
}

export interface SyntheticCommandCheckpoint {
  phase: "OWNED" | "EXECUTING" | "COMMITTED";
  commandId: string;
  executionToken: string;
}

export interface SyntheticCommandExecutionOptions {
  onCheckpoint?: (
    checkpoint: SyntheticCommandCheckpoint,
  ) => void | Promise<void>;
}

export interface SyntheticCommandHeartbeat {
  authority: SyntheticEnvironmentLeaseAuthority;
  commandId: string;
  executionToken: string;
}

export const SYNTHETIC_WORLD_CAPABILITIES = Object.freeze({
  available: [
    "lease-generation-fence",
    "durable-command-journal",
    "production-runtime-boot",
    "production-pglite-readback",
  ] as const,
  unavailable: [
    "full-manifest",
    "virtual-clock",
    "fault-injection",
    "observation-ledger",
    "cloud-command-journal-adapter",
    "atomic-production-domain-command",
    "subprocess-orchestration",
    "deployment-qualification",
  ] as const,
});
