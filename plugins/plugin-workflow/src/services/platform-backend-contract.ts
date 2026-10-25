/** Shared backend contract. Windows implementation is staged and unqualified; POSIX remains unchanged. */
export interface WorkerLeaseInput {
  rootDir: string;
  socketRoot: string;
  runId: string;
  versionId: string;
  sourceSha256: string;
}
export type WorkerLeaseState =
  | { state: 'absent' }
  | { state: 'live'; generation: string; pid: number }
  | { state: 'unknown'; reason: string };
export interface WorkerLeaseHandle {
  generation: string;
  /** Only after the actual Smithers canonical terminal receipt is durable. */
  finishCanonicalResult(): Promise<void>;
  /** Stop answering; preserve durable unknown reservation, never infer no effect. */
  abandon(): Promise<void>;
}
export interface WorkflowPlatformBackend {
  readonly platform: 'posix' | 'win32';
  /** Atomic no-replace publication; existing bytes and file identity stay unchanged. */
  publishWorkflowSource(sourcePath: string, source: string): Promise<void>;
  /** This runs in the worker before importing workflow source, never in parent only. */
  acquireWorkerLease(input: WorkerLeaseInput): Promise<WorkerLeaseHandle>;
  /** absent only for a verified missing reservation; errors/timeouts/replacement => unknown. */
  inspectWorkerLease(input: WorkerLeaseInput): Promise<WorkerLeaseState>;
}
// Production integration must statically bundle both implementations in worker prelude.
// Select Windows only on process.platform === 'win32'; retain existing POSIX code verbatim.
// Missing Windows capability is a typed unavailable error BEFORE durable run admission.
// Such an error is NOT an accepted permanent Windows feature removal or qualification pass.
