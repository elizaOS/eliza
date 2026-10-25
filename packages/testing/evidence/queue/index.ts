/** Public surface of the evidence GPU vision job queue (#14543): filesystem
 * queue, worker loop, analysis-merge, the runner's QueueExecutor, and the pure
 * state machine transitions. */

export { mergeAnalyzerResult } from "./analysis-merge.ts";
export { runQueueCli } from "./cli.ts";
export { QueueExecutor, type QueueExecutorOptions } from "./executor.ts";
export {
  type ClaimedJob,
  type EnqueueParams,
  FileJobQueue,
  type FileJobQueueOptions,
} from "./file-queue.ts";
export {
  claimOrder,
  createWorkerState,
  DEFAULT_LIMITS,
  decideEnqueue,
  drainSkipResult,
  isConnectivityFailure,
  type JobOutcomeStatus,
  type JobResult,
  makeJobId,
  onServiceOk,
  onServiceUnreachable,
  parseJob,
  QUEUE_DIRS,
  QueueBackpressureError,
  type QueueJob,
  QueueJobInvalidError,
  type QueueLimits,
  shouldDrain,
  type WorkerState,
} from "./state.ts";
export {
  type ProcessOutcome,
  processJob,
  type RunWorkerOptions,
  runQueueWorker,
  type WorkerAction,
  type WorkerEvent,
} from "./worker.ts";
