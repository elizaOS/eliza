/**
 * Type surface for the plain-node queue kernel in `queue-lib.mjs` (#14549).
 * Exists so TS consumers — notably the cross-layer drift guard
 * `packages/evidence/src/queue/parity.test.ts` — see a typed contract instead of
 * `any`; keep it in lockstep with the module's exports.
 */

export const QUEUE_DIRS: readonly string[];

export interface QueueLimits {
  maxPending: number;
  drainAfterMs: number;
  pollMs: number;
  requestTimeoutMs: number;
}
export const DEFAULT_LIMITS: Readonly<QueueLimits>;

export interface WorkerState {
  unreachableSince: number | null;
  draining: boolean;
}

export class QueueJobInvalidError extends Error {
  reason: string;
  constructor(reason: string);
}

export function parseJob(
  raw: string,
  knownModels: readonly string[],
): Record<string, unknown>;
export function claimOrder(fileNames: readonly string[]): string[];
export function decideEnqueue(
  pendingCount: number,
  maxPending: number,
): { accept: true } | { accept: false; reason: string };
export function createWorkerState(): WorkerState;
export function onServiceUnreachable(
  state: WorkerState,
  nowMs: number,
  drainAfterMs: number,
): WorkerState;
export function onServiceOk(): WorkerState;
export function shouldSkipJob(state: WorkerState): boolean;
export function resultRecord(
  job: Record<string, unknown>,
  outcome: { status: string; [key: string]: unknown },
  completedAtIso: string,
): Record<string, unknown>;
export const IMAGE_PLACEHOLDER: string;
export function resolveImagePlaceholders(
  request: unknown,
  dataUri: string,
): unknown;
export function makeJobId(nowMs: number, entropy: string): string;
