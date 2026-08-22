/**
 * Defines the fencing contract that synthetic-environment writers use across
 * local scenario processes and Cloud workers. Implementations must serialize
 * generation changes with guarded writes so validation cannot race a reset.
 */

export const SYNTHETIC_ENVIRONMENT_LEASE_VERSION = 1 as const;

export type SyntheticEnvironmentLeaseErrorCode =
  | "SYNTHETIC_LEASE_COLLISION"
  | "SYNTHETIC_LEASE_INVALID_INPUT"
  | "SYNTHETIC_LEASE_LOST"
  | "SYNTHETIC_LEASE_NOT_FOUND"
  | "SYNTHETIC_LEASE_STORAGE_FAILURE";

export interface SyntheticEnvironmentLeaseOwner {
  ownerId: string;
  processId: number | null;
  host: string;
}

export interface SyntheticEnvironmentLeaseAuthority {
  version: typeof SYNTHETIC_ENVIRONMENT_LEASE_VERSION;
  namespace: string;
  generation: number;
  leaseId: string;
  owner: SyntheticEnvironmentLeaseOwner;
}

export interface SyntheticEnvironmentLeaseSnapshot {
  version: typeof SYNTHETIC_ENVIRONMENT_LEASE_VERSION;
  namespace: string;
  generation: number;
  leaseId: string | null;
  owner: SyntheticEnvironmentLeaseOwner | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  releasedAt: string | null;
  revision: number;
  status: "active" | "expired" | "released";
  observedAt: string;
}

export interface SyntheticEnvironmentLeaseReceipt {
  operation:
    | "acquire"
    | "recover"
    | "heartbeat"
    | "rollover"
    | "release"
    | "guarded-write";
  authority: SyntheticEnvironmentLeaseAuthority;
  snapshot: SyntheticEnvironmentLeaseSnapshot;
}

export interface AcquireSyntheticEnvironmentLeaseInput {
  namespace: string;
  owner: SyntheticEnvironmentLeaseOwner;
  leaseDurationMs: number;
}

export interface RefreshSyntheticEnvironmentLeaseInput {
  authority: SyntheticEnvironmentLeaseAuthority;
  leaseDurationMs: number;
}

export interface GuardedSyntheticEnvironmentWriteResult<T> {
  value: T;
  receipt: SyntheticEnvironmentLeaseReceipt;
}

/**
 * A storage boundary that fences reset/reseed generations. The implementation
 * passes its authoritative transaction to each write so callers can mutate
 * production repositories within the same exclusion boundary.
 */
export interface SyntheticEnvironmentLeaseStore<TWriteContext> {
  acquire(
    input: AcquireSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt>;
  read(namespace: string): Promise<SyntheticEnvironmentLeaseSnapshot | null>;
  heartbeat(
    input: RefreshSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt>;
  rollover(
    input: RefreshSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt>;
  release(
    authority: SyntheticEnvironmentLeaseAuthority,
  ): Promise<SyntheticEnvironmentLeaseReceipt>;
  withActiveGeneration<T>(
    authority: SyntheticEnvironmentLeaseAuthority,
    write: (context: TWriteContext) => T | Promise<T>,
  ): Promise<GuardedSyntheticEnvironmentWriteResult<T>>;
}
