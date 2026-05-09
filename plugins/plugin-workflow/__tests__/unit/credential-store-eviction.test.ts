import { describe, expect, mock, test } from 'bun:test';
import type { EventPayload, IAgentRuntime } from '@elizaos/core';
import { WorkflowCredentialStore } from '../../src/services/workflow-credential-store';
import {
  CONNECTOR_DISCONNECTED_EVENT,
  type ConnectorDisconnectedPayload,
} from '../../src/types/index';

/**
 * Verifies the event-driven cache eviction wired up in
 * `WorkflowCredentialStore.start()`:
 *
 *  - Subscribes to `connector_disconnected` on start.
 *  - Calls `delete(userId, credType)` for every credType in the payload.
 *  - Unsubscribes on stop, so subsequent emits are no-ops.
 *
 * Uses a fake event bus + a spy on `WorkflowCredentialStore.prototype.delete`
 * so the test exercises the real subscribe/unsubscribe path without standing
 * up Postgres / pglite.
 */

type EventHandler = (payload: EventPayload) => Promise<void>;
type CredentialStoreRuntime = Pick<
  IAgentRuntime,
  | 'agentId'
  | 'db'
  | 'getService'
  | 'getSetting'
  | 'registerEvent'
  | 'unregisterEvent'
>;
type DeleteMethod = typeof WorkflowCredentialStore.prototype.delete;

interface EventBusRuntime {
  agentId: string;
  /** Map of event name → handler list. */
  events: Map<string, EventHandler[]>;
  emit: (
    eventName: string,
    payload: Omit<ConnectorDisconnectedPayload, 'runtime'>
  ) => Promise<void>;
  /** Number of currently-registered handlers for an event (for assertions). */
  handlerCount: (eventName: string) => number;
}

function createEventBusRuntime(agentId = 'agent-001'): {
  runtime: IAgentRuntime;
  bus: EventBusRuntime;
} {
  const events = new Map<string, EventHandler[]>();

  const bus: EventBusRuntime = {
    agentId,
    events,
    handlerCount: (eventName) => events.get(eventName)?.length ?? 0,
    emit: async (eventName, payload) => {
      const handlers = events.get(eventName) ?? [];
      // Mirror the real runtime's auto-injection of `runtime` + `source`.
      const fullPayload: ConnectorDisconnectedPayload = {
        ...payload,
        runtime,
        source: 'test',
      };
      await Promise.all(handlers.map((handler) => handler(fullPayload)));
    },
  };

  const runtimeDouble: CredentialStoreRuntime = {
    agentId,
    // The credential store reads `runtime.db` only inside DB methods we don't
    // call here (delete is spied on). A throwing getter would still satisfy
    // the type while making accidental DB access loud.
    get db() {
      throw new Error('runtime.db should not be touched in this test');
    },
    getService: () => null,
    getSetting: () => null,
    registerEvent: ((eventName: string, handler: EventHandler) => {
      const list = events.get(eventName) ?? [];
      list.push(handler);
      events.set(eventName, list);
    }) as IAgentRuntime['registerEvent'],
    unregisterEvent: ((eventName: string, handler: EventHandler) => {
      const list = events.get(eventName);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) events.delete(eventName);
    }) as IAgentRuntime['unregisterEvent'],
  };
  const runtime = runtimeDouble as IAgentRuntime;

  return { runtime, bus };
}

describe('WorkflowCredentialStore event-driven eviction', () => {
  test('start() subscribes and emit invokes delete() for every credType', async () => {
    const { runtime, bus } = createEventBusRuntime('agent-evict-1');
    const deleteSpy = mock<DeleteMethod>(() => Promise.resolve());
    // Spy on the prototype so the subscriber's `this.delete(...)` call routes
    // to the mock without touching the real DB-backed implementation.
    const originalDelete = WorkflowCredentialStore.prototype.delete;
    WorkflowCredentialStore.prototype.delete = deleteSpy;

    try {
      const store = await WorkflowCredentialStore.start(runtime);
      expect(bus.handlerCount(CONNECTOR_DISCONNECTED_EVENT)).toBe(1);

      await bus.emit(CONNECTOR_DISCONNECTED_EVENT, {
        userId: 'agent-evict-1',
        credTypes: ['gmailOAuth2', 'gmailOAuth2Api'],
        connectorName: 'gmail',
      });

      expect(deleteSpy).toHaveBeenCalledTimes(2);
      expect(deleteSpy).toHaveBeenCalledWith('agent-evict-1', 'gmailOAuth2');
      expect(deleteSpy).toHaveBeenCalledWith('agent-evict-1', 'gmailOAuth2Api');

      await store.stop();
    } finally {
      WorkflowCredentialStore.prototype.delete = originalDelete;
    }
  });

  test('empty credTypes payload is a no-op', async () => {
    const { runtime, bus } = createEventBusRuntime('agent-evict-2');
    const deleteSpy = mock<DeleteMethod>(() => Promise.resolve());
    const originalDelete = WorkflowCredentialStore.prototype.delete;
    WorkflowCredentialStore.prototype.delete = deleteSpy;

    try {
      const store = await WorkflowCredentialStore.start(runtime);
      await bus.emit(CONNECTOR_DISCONNECTED_EVENT, {
        userId: 'agent-evict-2',
        credTypes: [],
        connectorName: 'unmapped-connector',
      });
      expect(deleteSpy).not.toHaveBeenCalled();
      await store.stop();
    } finally {
      WorkflowCredentialStore.prototype.delete = originalDelete;
    }
  });

  test('stop() unsubscribes — subsequent emits do not invoke delete', async () => {
    const { runtime, bus } = createEventBusRuntime('agent-evict-3');
    const deleteSpy = mock<DeleteMethod>(() => Promise.resolve());
    const originalDelete = WorkflowCredentialStore.prototype.delete;
    WorkflowCredentialStore.prototype.delete = deleteSpy;

    try {
      const store = await WorkflowCredentialStore.start(runtime);
      expect(bus.handlerCount(CONNECTOR_DISCONNECTED_EVENT)).toBe(1);

      await store.stop();
      expect(bus.handlerCount(CONNECTOR_DISCONNECTED_EVENT)).toBe(0);

      await bus.emit(CONNECTOR_DISCONNECTED_EVENT, {
        userId: 'agent-evict-3',
        credTypes: ['slackApi'],
        connectorName: 'slack',
      });
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      WorkflowCredentialStore.prototype.delete = originalDelete;
    }
  });

  test('a delete failure for one credType does not block sibling deletes', async () => {
    const { runtime, bus } = createEventBusRuntime('agent-evict-4');
    const calls: Array<[string, string]> = [];
    const deleteSpy = mock<DeleteMethod>(async (userId: string, credType: string) => {
      calls.push([userId, credType]);
      if (credType === 'discordApi') {
        throw new Error('boom');
      }
    });
    const originalDelete = WorkflowCredentialStore.prototype.delete;
    WorkflowCredentialStore.prototype.delete = deleteSpy;

    try {
      const store = await WorkflowCredentialStore.start(runtime);
      await bus.emit(CONNECTOR_DISCONNECTED_EVENT, {
        userId: 'agent-evict-4',
        credTypes: ['discordApi', 'discordBotApi', 'discordWebhookApi'],
        connectorName: 'discord',
      });

      const seen = new Set(calls.map(([, credType]) => credType));
      expect(seen.has('discordApi')).toBe(true);
      expect(seen.has('discordBotApi')).toBe(true);
      expect(seen.has('discordWebhookApi')).toBe(true);

      await store.stop();
    } finally {
      WorkflowCredentialStore.prototype.delete = originalDelete;
    }
  });
});
