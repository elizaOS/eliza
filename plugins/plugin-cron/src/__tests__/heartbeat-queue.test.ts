import { describe, it, expect, beforeEach } from 'vitest';
import { pushSystemEvent, drainSystemEvents, pendingEventCount } from '../heartbeat/queue.js';

describe('heartbeat/queue', () => {
  const agentId = 'test-agent-1';

  beforeEach(() => {
    // Drain anything left from previous tests
    drainSystemEvents(agentId);
  });

  it('starts with zero pending events', () => {
    expect(pendingEventCount(agentId)).toBe(0);
  });

  it('pushes and drains events', () => {
    pushSystemEvent(agentId, 'event one', 'test');
    pushSystemEvent(agentId, 'event two', 'test');

    expect(pendingEventCount(agentId)).toBe(2);

    const events = drainSystemEvents(agentId);
    expect(events).toHaveLength(2);
    expect(events[0].text).toBe('event one');
    expect(events[1].text).toBe('event two');
    expect(events[0].source).toBe('test');
    expect(events[0].ts).toBeGreaterThan(0);
  });

  it('draining clears the queue', () => {
    pushSystemEvent(agentId, 'event', 'test');
    drainSystemEvents(agentId);

    expect(pendingEventCount(agentId)).toBe(0);
    expect(drainSystemEvents(agentId)).toHaveLength(0);
  });

  it('isolates queues by agent ID', () => {
    const agent2 = 'test-agent-2';
    pushSystemEvent(agentId, 'for agent 1', 'test');
    pushSystemEvent(agent2, 'for agent 2', 'test');

    expect(pendingEventCount(agentId)).toBe(1);
    expect(pendingEventCount(agent2)).toBe(1);

    const events1 = drainSystemEvents(agentId);
    expect(events1[0].text).toBe('for agent 1');

    const events2 = drainSystemEvents(agent2);
    expect(events2[0].text).toBe('for agent 2');

    // Clean up
    drainSystemEvents(agent2);
  });

  it('returns empty array for unknown agent', () => {
    expect(drainSystemEvents('nonexistent')).toHaveLength(0);
    expect(pendingEventCount('nonexistent')).toBe(0);
  });
});
