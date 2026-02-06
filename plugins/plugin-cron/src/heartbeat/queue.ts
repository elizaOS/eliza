/**
 * @module heartbeat/queue
 * @description In-memory queue for system events destined for the next heartbeat tick.
 *
 * Cron main-session jobs push text here via pushSystemEvent().
 * The heartbeat worker drains the queue on each tick and includes
 * the events in the heartbeat prompt so the agent can act on them.
 */

export interface SystemEvent {
  text: string;
  source: string;
  ts: number;
}

const queues = new Map<string, SystemEvent[]>();

function agentQueue(agentId: string): SystemEvent[] {
  let q = queues.get(agentId);
  if (!q) {
    q = [];
    queues.set(agentId, q);
  }
  return q;
}

/**
 * Push a system event for delivery on the next heartbeat tick.
 */
export function pushSystemEvent(agentId: string, text: string, source: string): void {
  agentQueue(agentId).push({ text, source, ts: Date.now() });
}

/**
 * Drain all pending system events for an agent.
 * Returns the events and clears the queue.
 */
export function drainSystemEvents(agentId: string): SystemEvent[] {
  const q = queues.get(agentId);
  if (!q || q.length === 0) {
    return [];
  }
  const events = [...q];
  q.length = 0;
  return events;
}

/**
 * Peek at pending event count without draining.
 */
export function pendingEventCount(agentId: string): number {
  return queues.get(agentId)?.length ?? 0;
}
