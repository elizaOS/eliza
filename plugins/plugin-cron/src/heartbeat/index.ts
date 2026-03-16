/**
 * @module heartbeat
 * @description Heartbeat subsystem – periodic agent wakeup via Eliza's Task system.
 */

export { pushSystemEvent, drainSystemEvents, pendingEventCount, type SystemEvent } from './queue.js';
export { resolveHeartbeatConfig, isWithinActiveHours, type HeartbeatConfig, type ActiveHours } from './config.js';
export {
  heartbeatWorker,
  startHeartbeat,
  wakeHeartbeatNow,
  HEARTBEAT_WORKER_NAME,
} from './worker.js';
export {
  resolveDeliveryTarget,
  deliverToTarget,
  type DeliveryTarget,
} from './delivery.js';
