import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { AgentRuntime } from '../runtime';
import {
  runWithRequestContext,
  setRequestContextManager,
  getRequestContextManager,
  type RequestContext,
  type IRequestContextManager,
  type EntitySettingValue,
} from '../request-context';
import * as requestContextModule from '../request-context';
import { createNodeRequestContextManager } from '../request-context.node';
import type { Character, IDatabaseAdapter, UUID } from '../types';
import { v4 as uuidv4 } from 'uuid';

const uuid = (): UUID => uuidv4() as UUID;

const createMockAdapter = (): IDatabaseAdapter =>
  ({
    isRoomParticipant: mock().mockResolvedValue(true),
    db: {},
    init: mock().mockResolvedValue(undefined),
    initialize: mock().mockResolvedValue(undefined),
    isReady: mock().mockResolvedValue(true),
    close: mock().mockResolvedValue(undefined),
    getConnection: mock().mockResolvedValue({}),
    getEntitiesByIds: mock().mockResolvedValue([]),
    createEntities: mock().mockResolvedValue(true),
    getMemories: mock().mockResolvedValue([]),
    getMemoryById: mock().mockResolvedValue(null),
    getMemoriesByRoomIds: mock().mockResolvedValue([]),
    getMemoriesByIds: mock().mockResolvedValue([]),
    getCachedEmbeddings: mock().mockResolvedValue([]),
    log: mock().mockResolvedValue(undefined),
    searchMemories: mock().mockResolvedValue([]),
    createMemory: mock().mockResolvedValue(uuid()),
    deleteMemory: mock().mockResolvedValue(undefined),
    deleteManyMemories: mock().mockResolvedValue(undefined),
    deleteAllMemories: mock().mockResolvedValue(undefined),
    countMemories: mock().mockResolvedValue(0),
    getRoomsByIds: mock().mockResolvedValue([]),
    createRooms: mock().mockResolvedValue([uuid()]),
    deleteRoom: mock().mockResolvedValue(undefined),
    getRoomsForParticipant: mock().mockResolvedValue([]),
    getRoomsForParticipants: mock().mockResolvedValue([]),
    addParticipantsRoom: mock().mockResolvedValue(true),
    removeParticipant: mock().mockResolvedValue(true),
    getParticipantsForEntity: mock().mockResolvedValue([]),
    getParticipantsForRoom: mock().mockResolvedValue([]),
    getParticipantUserState: mock().mockResolvedValue(null),
    setParticipantUserState: mock().mockResolvedValue(undefined),
    createRelationship: mock().mockResolvedValue(true),
    getRelationship: mock().mockResolvedValue(null),
    getRelationships: mock().mockResolvedValue([]),
    getAgent: mock().mockResolvedValue(null),
    getAgents: mock().mockResolvedValue([]),
    createAgent: mock().mockResolvedValue(true),
    updateAgent: mock().mockResolvedValue(true),
    deleteAgent: mock().mockResolvedValue(true),
    ensureEmbeddingDimension: mock().mockResolvedValue(undefined),
    getEntitiesForRoom: mock().mockResolvedValue([]),
    updateEntity: mock().mockResolvedValue(undefined),
    getComponent: mock().mockResolvedValue(null),
    getComponents: mock().mockResolvedValue([]),
    createComponent: mock().mockResolvedValue(true),
    updateComponent: mock().mockResolvedValue(undefined),
    deleteComponent: mock().mockResolvedValue(undefined),
    createWorld: mock().mockResolvedValue(uuid()),
    getWorld: mock().mockResolvedValue(null),
    getAllWorlds: mock().mockResolvedValue([]),
    updateWorld: mock().mockResolvedValue(undefined),
    updateRoom: mock().mockResolvedValue(undefined),
    getRoomsByWorld: mock().mockResolvedValue([]),
    updateRelationship: mock().mockResolvedValue(undefined),
    getCache: mock().mockResolvedValue(undefined),
    setCache: mock().mockResolvedValue(true),
    deleteCache: mock().mockResolvedValue(true),
    createTask: mock().mockResolvedValue(uuid()),
    getTasks: mock().mockResolvedValue([]),
    getTask: mock().mockResolvedValue(null),
    getTasksByName: mock().mockResolvedValue([]),
    updateTask: mock().mockResolvedValue(undefined),
    deleteTask: mock().mockResolvedValue(undefined),
    updateMemory: mock().mockResolvedValue(true),
    getLogs: mock().mockResolvedValue([]),
    deleteLog: mock().mockResolvedValue(undefined),
    removeWorld: mock().mockResolvedValue(undefined),
    deleteRoomsByWorldId: mock().mockResolvedValue(undefined),
    getMemoriesByWorldId: mock().mockResolvedValue([]),
  }) as unknown as IDatabaseAdapter;

describe('Runtime getSetting with Request Context', () => {
  let originalManager: IRequestContextManager;
  let adapter: IDatabaseAdapter;

  beforeEach(() => {
    originalManager = getRequestContextManager();
    setRequestContextManager(createNodeRequestContextManager());
    adapter = createMockAdapter();
  });

  afterEach(() => {
    setRequestContextManager(originalManager);
  });

  describe('Code Path Verification', () => {
    it('calls getRequestContext inside getSetting', () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [] },
        agentId,
        adapter,
      });

      const spy = spyOn(requestContextModule, 'getRequestContext');

      runWithRequestContext(
        {
          entityId: uuid(),
          agentId,
          entitySettings: new Map([['KEY', 'value']]),
          requestStartTime: Date.now(),
        },
        () => runtime.getSetting('KEY')
      );

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('uses mocked context value', () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [], settings: { KEY: 'char-value' } },
        agentId,
        adapter,
      });

      const spy = spyOn(requestContextModule, 'getRequestContext').mockReturnValue({
        entityId: uuid(),
        agentId,
        entitySettings: new Map([['KEY', 'mocked-value']]),
        requestStartTime: Date.now(),
      });

      expect(runtime.getSetting('KEY')).toBe('mocked-value');
      spy.mockRestore();
    });

    it('skips decryptSecret for entity settings', async () => {
      const indexModule = await import('../index');
      const spy = spyOn(indexModule, 'decryptSecret');

      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [] },
        agentId,
        adapter,
      });

      runWithRequestContext(
        {
          entityId: uuid(),
          agentId,
          entitySettings: new Map([['SECRET', 'pre-decrypted']]),
          requestStartTime: Date.now(),
        },
        () => {
          expect(runtime.getSetting('SECRET')).toBe('pre-decrypted');
        }
      );

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('calls decryptSecret for character settings only', async () => {
      const indexModule = await import('../index');
      const spy = spyOn(indexModule, 'decryptSecret').mockImplementation((v: string) => `dec:${v}`);

      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [], settings: { CHAR: 'char-val' } },
        agentId,
        adapter,
      });

      runWithRequestContext(
        {
          entityId: uuid(),
          agentId,
          entitySettings: new Map([['ENTITY', 'entity-val']]),
          requestStartTime: Date.now(),
        },
        () => {
          expect(runtime.getSetting('ENTITY')).toBe('entity-val');
          expect(runtime.getSetting('CHAR')).toBe('dec:char-val');
        }
      );

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('NoopContextManager', () => {
    it('falls back to character settings', () => {
      setRequestContextManager({
        run: <T>(_: RequestContext | undefined, fn: () => T) => fn(),
        active: () => undefined,
      });

      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [], settings: { KEY: 'char-value' } },
        agentId,
        adapter,
      });

      runWithRequestContext(
        {
          entityId: uuid(),
          agentId,
          entitySettings: new Map([['KEY', 'ignored']]),
          requestStartTime: Date.now(),
        },
        () => {
          expect(runtime.getSetting('KEY')).toBe('char-value');
        }
      );
    });
  });

  describe('Priority', () => {
    it('entity settings override character settings', () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: {
          id: agentId,
          name: 'Test',
          plugins: [],
          settings: { KEY: 'char', OTHER: 'char-other' },
        },
        agentId,
        adapter,
      });

      expect(runtime.getSetting('KEY')).toBe('char');

      runWithRequestContext(
        {
          entityId: uuid(),
          agentId,
          entitySettings: new Map([['KEY', 'entity']]),
          requestStartTime: Date.now(),
        },
        () => {
          expect(runtime.getSetting('KEY')).toBe('entity');
          expect(runtime.getSetting('OTHER')).toBe('char-other');
        }
      );
    });

    it('entity settings override character secrets', () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [], secrets: { SECRET: 'char-secret' } },
        agentId,
        adapter,
      });

      expect(runtime.getSetting('SECRET')).toBe('char-secret');

      runWithRequestContext(
        {
          entityId: uuid(),
          agentId,
          entitySettings: new Map([['SECRET', 'entity-secret']]),
          requestStartTime: Date.now(),
        },
        () => {
          expect(runtime.getSetting('SECRET')).toBe('entity-secret');
        }
      );
    });

    it('null entity setting returns null (no fallthrough)', () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [], settings: { KEY: 'char-value' } },
        agentId,
        adapter,
      });

      runWithRequestContext(
        {
          entityId: uuid(),
          agentId,
          entitySettings: new Map<string, EntitySettingValue>([['KEY', null]]),
          requestStartTime: Date.now(),
        },
        () => {
          expect(runtime.getSetting('KEY')).toBeNull();
        }
      );
    });
  });

  describe('Value Types', () => {
    it('returns all types correctly', () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [] },
        agentId,
        adapter,
      });

      runWithRequestContext(
        {
          entityId: uuid(),
          agentId,
          entitySettings: new Map<string, EntitySettingValue>([
            ['STR', 'string'],
            ['NUM', 42],
            ['BOOL_T', true],
            ['BOOL_F', false],
            ['ZERO', 0],
            ['EMPTY', ''],
          ]),
          requestStartTime: Date.now(),
        },
        () => {
          expect(runtime.getSetting('STR')).toBe('string');
          expect(runtime.getSetting('NUM')).toBe(42);
          expect(runtime.getSetting('BOOL_T')).toBe(true);
          expect(runtime.getSetting('BOOL_F')).toBe(false);
          expect(runtime.getSetting('ZERO')).toBe(0);
          expect(runtime.getSetting('EMPTY')).toBe('');
        }
      );
    });
  });

  describe('Multi-tenant Isolation', () => {
    it('isolates concurrent users on shared runtime', async () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Shared', plugins: [], settings: { DEFAULT: 'default' } },
        agentId,
        adapter,
      });

      const user1: string[] = [];
      const user2: string[] = [];

      await Promise.all([
        runWithRequestContext(
          {
            entityId: uuid(),
            agentId,
            entitySettings: new Map([['KEY', 'user1']]),
            requestStartTime: Date.now(),
          },
          async () => {
            await new Promise((r) => setTimeout(r, 10));
            user1.push(runtime.getSetting('KEY') as string);
            user1.push(runtime.getSetting('DEFAULT') as string);
          }
        ),
        runWithRequestContext(
          {
            entityId: uuid(),
            agentId,
            entitySettings: new Map([['KEY', 'user2']]),
            requestStartTime: Date.now(),
          },
          async () => {
            await new Promise((r) => setTimeout(r, 5));
            user2.push(runtime.getSetting('KEY') as string);
            user2.push(runtime.getSetting('DEFAULT') as string);
          }
        ),
      ]);

      expect(user1).toEqual(['user1', 'default']);
      expect(user2).toEqual(['user2', 'default']);
    });
  });

  describe('Backward Compatibility', () => {
    it('works without context', () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: {
          id: agentId,
          name: 'Test',
          plugins: [],
          settings: { A: 'a' },
          secrets: { B: 'b' },
        },
        agentId,
        adapter,
      });

      expect(runtime.getSetting('A')).toBe('a');
      expect(runtime.getSetting('B')).toBe('b');
      expect(runtime.getSetting('MISSING')).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('empty entity settings falls through', () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [], settings: { KEY: 'char' } },
        agentId,
        adapter,
      });

      runWithRequestContext(
        { entityId: uuid(), agentId, entitySettings: new Map(), requestStartTime: Date.now() },
        () => {
          expect(runtime.getSetting('KEY')).toBe('char');
        }
      );
    });

    it('propagates errors', () => {
      const agentId = uuid();
      const runtime = new AgentRuntime({
        character: { id: agentId, name: 'Test', plugins: [] },
        agentId,
        adapter,
      });

      expect(() => {
        runWithRequestContext(
          { entityId: uuid(), agentId, entitySettings: new Map(), requestStartTime: Date.now() },
          () => {
            runtime.getSetting('KEY');
            throw new Error('test error');
          }
        );
      }).toThrow('test error');
    });
  });
});
