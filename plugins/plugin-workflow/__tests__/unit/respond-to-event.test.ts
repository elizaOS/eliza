import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import defaultNodes from '../../src/data/defaultNodes.json';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';

interface CapturedMemory {
  entityId: string;
  roomId: UUID;
  content: {
    text: string;
    source: string;
    metadata: Record<string, unknown>;
  };
}

interface AutonomyMockOptions {
  roomId?: UUID | null;
  via?: 'autonomous' | 'target';
}

function buildAutonomyService({
  roomId,
  via = 'autonomous',
}: AutonomyMockOptions): Record<string, unknown> {
  if (via === 'target') {
    return { getTargetRoomId: () => roomId ?? undefined };
  }
  return { getAutonomousRoomId: () => roomId ?? undefined };
}

interface RuntimeMockOptions {
  autonomy?: AutonomyMockOptions | null;
  serviceKey?: 'AUTONOMY' | 'autonomy';
  db?: unknown;
}

function buildRuntime(options: RuntimeMockOptions = {}): {
  runtime: IAgentRuntime;
  capturedMemories: CapturedMemory[];
  warnings: Array<{ context: unknown; message: string }>;
} {
  const capturedMemories: CapturedMemory[] = [];
  const warnings: Array<{ context: unknown; message: string }> = [];
  const services: Record<string, unknown> = {};
  if (options.autonomy) {
    services[options.serviceKey ?? 'AUTONOMY'] = buildAutonomyService(options.autonomy);
  }

  const runtime = {
    agentId: 'agent-respond-to-event' as UUID,
    db: options.db,
    getSetting: () => null,
    getService: (type: string) => services[type] ?? services[type.toLowerCase()] ?? null,
    createMemory: mock(async (memory: CapturedMemory, _table: string) => {
      capturedMemories.push(memory);
      return memory;
    }),
    logger: {
      warn: (context: unknown, message: string) => {
        warnings.push({ context, message });
      },
      info: () => {},
      error: () => {},
      debug: () => {},
    },
  } as unknown as IAgentRuntime;

  return { runtime, capturedMemories, warnings };
}

interface PersistentHarness {
  runtime: IAgentRuntime;
  capturedMemories: CapturedMemory[];
  warnings: Array<{ context: unknown; message: string }>;
  close(): Promise<void>;
}

async function persistentRuntime(
  options: RuntimeMockOptions = {}
): Promise<PersistentHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'respond-to-event-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const built = buildRuntime({ ...options, db });
  return {
    runtime: built.runtime,
    capturedMemories: built.capturedMemories,
    warnings: built.warnings,
    async close() {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const ROOM_ID = 'autonomy-room-id' as UUID;

async function runRespondToEventWorkflow(
  service: EmbeddedWorkflowService,
  parameters: Record<string, unknown>,
  options: { withInputEvent?: { kind: string; payload: Record<string, unknown> } } = {}
) {
  const startNodes = options.withInputEvent
    ? [
        {
          id: 'set-event',
          name: 'Set Event',
          type: 'workflows-nodes-base.set',
          typeVersion: 3.4,
          position: [0, 0] as [number, number],
          parameters: {
            assignments: {
              assignments: [
                { name: 'eventKind', value: options.withInputEvent.kind },
                {
                  name: 'eventPayload',
                  value: options.withInputEvent.payload,
                },
              ],
            },
          },
        },
      ]
    : [
        {
          id: 'manual',
          name: 'Manual Trigger',
          type: 'workflows-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0] as [number, number],
          parameters: {},
        },
      ];

  const startNodeName = startNodes[0].name;
  const created = await service.createWorkflow({
    name: `respondToEvent ${Date.now()}`,
    nodes: [
      ...startNodes,
      {
        id: 'respond',
        name: 'Respond',
        type: 'workflows-nodes-base.respondToEvent',
        typeVersion: 1,
        position: [200, 0] as [number, number],
        parameters,
      },
    ],
    connections: {
      [startNodeName]: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] },
    },
  });
  return service.executeWorkflow(created.id);
}

function firstRunJson(
  execution: { data?: { resultData?: { runData?: Record<string, unknown[]> } } },
  nodeName: string
): Record<string, unknown> | undefined {
  const run = execution.data?.resultData?.runData?.[nodeName]?.[0] as
    | { data?: { main?: Array<Array<{ json?: Record<string, unknown> }>> } }
    | undefined;
  return run?.data?.main?.[0]?.[0]?.json;
}

describe('workflows-nodes-base.respondToEvent', () => {
  test('happy path: injects a memory into the autonomy room', async () => {
    const harness = await persistentRuntime({
      autonomy: { roomId: ROOM_ID },
    });
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const execution = await runRespondToEventWorkflow(service, {
        instructions: 'Reply to the user warmly',
        displayName: 'Greet User',
        wakeMode: 'inject_now',
      });

      expect(execution.status).toBe('success');
      expect(harness.capturedMemories).toHaveLength(1);
      const memory = harness.capturedMemories[0];
      expect(memory.roomId).toBe(ROOM_ID);
      expect(memory.entityId).toBe('agent-respond-to-event');
      expect(memory.content.text).toBe('[Greet User]\nReply to the user warmly');
      expect(memory.content.source).toBe('workflow:respondToEvent');
      expect(memory.content.metadata.nodeName).toBe('Respond');
      expect(memory.content.metadata.wakeMode).toBe('inject_now');
      expect(memory.content.metadata.workflowExecutionId).toEqual(expect.any(String));
      expect(memory.content.metadata.isAutonomousInstruction).toBe(true);

      const json = firstRunJson(execution, 'Respond');
      expect(json?.instructionInjected).toBe(true);
      expect(json?.roomId).toBe(ROOM_ID);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('returns failure when no autonomy service is registered (does not throw)', async () => {
    const harness = await persistentRuntime({ autonomy: null });
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const execution = await runRespondToEventWorkflow(service, {
        instructions: 'Should be skipped',
      });

      expect(execution.status).toBe('success');
      expect(harness.capturedMemories).toHaveLength(0);
      const json = firstRunJson(execution, 'Respond');
      expect(json?.instructionInjected).toBe(false);
      expect(json?.reason).toBe('autonomy_service_unavailable');
      expect(harness.warnings.some((w) => w.message.includes('Autonomy service not registered'))).toBe(
        true
      );
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('returns failure when autonomy service has no resolvable room (does not throw)', async () => {
    const harness = await persistentRuntime({ autonomy: { roomId: null } });
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const execution = await runRespondToEventWorkflow(service, {
        instructions: 'Should be skipped',
      });

      expect(execution.status).toBe('success');
      expect(harness.capturedMemories).toHaveLength(0);
      const json = firstRunJson(execution, 'Respond');
      expect(json?.instructionInjected).toBe(false);
      expect(json?.reason).toBe('no_autonomy_room');
      expect(
        harness.warnings.some((w) => w.message.includes('No autonomy room resolvable'))
      ).toBe(true);
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('includes event payload from input items in the instruction', async () => {
    const harness = await persistentRuntime({
      autonomy: { roomId: ROOM_ID },
    });
    const service = await EmbeddedWorkflowService.start(harness.runtime);
    try {
      const execution = await runRespondToEventWorkflow(
        service,
        {
          instructions: 'Handle this event',
          displayName: 'Event Handler',
        },
        {
          withInputEvent: {
            kind: 'imessage.received',
            payload: { from: '+15551234567', text: 'hello' },
          },
        }
      );

      expect(execution.status).toBe('success');
      expect(harness.capturedMemories).toHaveLength(1);
      const memory = harness.capturedMemories[0];
      expect(memory.content.text).toContain('[Event Handler]');
      expect(memory.content.text).toContain('Handle this event');
      expect(memory.content.text).toContain('Event: imessage.received');
      expect(memory.content.text).toContain('"from":"+15551234567"');
      expect(memory.content.text).toContain('"text":"hello"');
    } finally {
      await service.stop();
      await harness.close();
    }
  }, 60_000);

  test('catalog contains workflows-nodes-base.respondToEvent with required properties', () => {
    const entries = defaultNodes as Array<{
      name: string;
      displayName: string;
      version: number | number[];
      inputs: unknown;
      outputs: unknown;
      properties: Array<{ name: string; type: string; required?: boolean; default?: unknown; options?: unknown }>;
    }>;
    const entry = entries.find((node) => node.name === 'workflows-nodes-base.respondToEvent');
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.displayName).toBe('Respond to Event');
    expect(Array.isArray(entry.inputs) ? entry.inputs : [entry.inputs]).toContain('main');
    expect(Array.isArray(entry.outputs) ? entry.outputs : [entry.outputs]).toContain('main');

    const propertyByName = new Map(entry.properties.map((property) => [property.name, property]));
    const instructions = propertyByName.get('instructions');
    expect(instructions).toBeDefined();
    expect(instructions?.type).toBe('string');
    expect(instructions?.required).toBe(true);

    const displayName = propertyByName.get('displayName');
    expect(displayName).toBeDefined();
    expect(displayName?.type).toBe('string');

    const wakeMode = propertyByName.get('wakeMode');
    expect(wakeMode).toBeDefined();
    expect(wakeMode?.type).toBe('options');
    expect(wakeMode?.default).toBe('inject_now');
    const wakeModeOptions = (wakeMode?.options as Array<{ value: string }>) ?? [];
    const wakeModeValues = wakeModeOptions.map((option) => option.value);
    expect(wakeModeValues).toContain('inject_now');
    expect(wakeModeValues).toContain('next_autonomy_cycle');
  });
});
