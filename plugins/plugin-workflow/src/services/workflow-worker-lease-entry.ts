import { acquireWorkerLease } from './workflow-worker-lease';

Object.assign(globalThis, { __elizaAcquireWorkerLease: acquireWorkerLease });
