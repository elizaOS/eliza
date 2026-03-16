import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { reflectionEvaluator } from '../reflection';
import * as core from '@elizaos/core';
import type { IAgentRuntime, Memory, UUID, Entity, Relationship } from '@elizaos/core';

// Use vi.spyOn instead of vi.mock
const getEntityDetailsSpy = vi.spyOn(core, 'getEntityDetails');

const createMockRuntime = (): IAgentRuntime =>
  ({
    agentId: 'test-agent' as UUID,
    character: {
        name: 'TestAgent',
        templates: {},
    },
    getRelationships: vi.fn().mockResolvedValue([]),
    getMemories: vi.fn().mockResolvedValue([]),
    getCache: vi.fn().mockResolvedValue(null),
    setCache: vi.fn().mockResolvedValue(undefined),
    useModel: vi.fn(),
    addEmbeddingToMemory: vi.fn(mem => Promise.resolve(mem)),
    createMemory: vi.fn().mockResolvedValue(true),
    updateRelationship: vi.fn().mockResolvedValue(true),
    createRelationship: vi.fn().mockResolvedValue(true),
  } as any);

const mockEntities: Entity[] = [
    { id: 'user-a' as UUID, agentId: 'test-agent' as UUID, names: ['Alice'] } as Entity,
    { id: 'user-b' as UUID, agentId: 'test-agent' as UUID, names: ['Bob'] } as Entity,
];

const mockMemory = (entityId: UUID): Memory => ({
    id: 'mem-1' as UUID,
    agentId: 'test-agent' as UUID,
    entityId: entityId,
    roomId: 'room-1' as UUID,
    content: { text: 'Hello Bob' },
    createdAt: Date.now()
} as Memory);


describe('reflectionEvaluator', () => {
    let runtime: IAgentRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
        runtime = createMockRuntime();
        getEntityDetailsSpy.mockResolvedValue(mockEntities);
    });

    describe('handler', () => {
        it('should create new facts from the conversation', async () => {
            const firstEntity = mockEntities[0];
            if (!firstEntity || !firstEntity.id) throw new Error('No mock entities');
            const message = mockMemory(firstEntity.id);
            const modelResponse = {
                facts: [{ claim: 'Bob is a builder', type: 'fact', in_bio: false, already_known: false }],
                relationships: [],
            };
            (runtime.useModel as Mock).mockResolvedValue(modelResponse);

            await reflectionEvaluator.handler(runtime, message);

            expect(runtime.addEmbeddingToMemory).toHaveBeenCalledOnce();
            expect(runtime.createMemory).toHaveBeenCalledOnce();
            const createdFact = (runtime.createMemory as Mock).mock.calls[0][0];
            expect(createdFact.content.text).toBe('Bob is a builder');
        });

        it('should update an existing relationship', async () => {
            const firstEntity = mockEntities[0];
            const secondEntity = mockEntities[1];
            if (!firstEntity || !secondEntity || !firstEntity.id || !secondEntity.id) throw new Error('Not enough mock entities');
            
            const message = mockMemory(firstEntity.id);
            const existingRelationship = {
                id: 'rel-1' as UUID,
                agentId: runtime.agentId,
                sourceEntityId: firstEntity.id,
                targetEntityId: secondEntity.id,
                type: 'knows',
                tags: [],
                metadata: { interactions: 1 }
            } as any;
            (runtime.getRelationships as Mock).mockResolvedValue([existingRelationship]);
            
            const modelResponse = {
                facts: [],
                relationships: [{ sourceEntityId: 'Alice', targetEntityId: 'Bob', tags: ['group_interaction'] }]
            };
            (runtime.useModel as Mock).mockResolvedValue(modelResponse);

            await reflectionEvaluator.handler(runtime, message);

            expect(runtime.updateRelationship).toHaveBeenCalledOnce();
            const updatedRel = (runtime.updateRelationship as Mock).mock.calls[0][0];
            expect(updatedRel.id).toBe(existingRelationship.id);
            expect(updatedRel.metadata.interactions).toBe(2);
        });

        it('should create a new relationship if one does not exist', async () => {
            const firstEntity = mockEntities[0];
            const secondEntity = mockEntities[1];
            if (!firstEntity || !secondEntity || !firstEntity.id || !secondEntity.id) throw new Error('Not enough mock entities');
            
            const message = mockMemory(firstEntity.id);
            (runtime.getRelationships as Mock).mockResolvedValue([]);
            const modelResponse = {
                facts: [],
                relationships: [{ sourceEntityId: 'Alice', targetEntityId: 'Bob', tags: ['dm_interaction'] }]
            };
            (runtime.useModel as Mock).mockResolvedValue(modelResponse);

            await reflectionEvaluator.handler(runtime, message);

            expect(runtime.createRelationship).toHaveBeenCalledOnce();
            const newRel = (runtime.createRelationship as Mock).mock.calls[0][0];
            expect(newRel.sourceEntityId).toBe(firstEntity.id);
            expect(newRel.targetEntityId).toBe(secondEntity.id);
        });

        it('should not process facts that are already known', async () => {
            const firstEntity = mockEntities[0];
            if (!firstEntity || !firstEntity.id) throw new Error('No mock entities');
            
            const message = mockMemory(firstEntity.id);
            const modelResponse = {
                facts: [{ claim: 'fact 1', type: 'fact', in_bio: false, already_known: true }],
                relationships: [],
            };
            (runtime.useModel as Mock).mockResolvedValue(modelResponse);

            await reflectionEvaluator.handler(runtime, message);

            expect(runtime.createMemory).not.toHaveBeenCalled();
        });
    });
}); 