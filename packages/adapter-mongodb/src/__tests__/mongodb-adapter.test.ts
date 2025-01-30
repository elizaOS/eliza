import { MongoClient } from 'mongodb';
import { MongoDBDatabaseAdapter } from '../index';
import { v4 as uuidv4 } from 'uuid';
import { RAGKnowledgeItem, type UUID } from '@elizaos/core';

describe('MongoDBAdapter', () => {
    let adapter: MongoDBDatabaseAdapter;
    const testUrl = 'mongodb://mongodb:mongodb@localhost:27018';
    const dbName = 'eliza_test';

    beforeAll(async () => {
        adapter = new MongoDBDatabaseAdapter(new MongoClient(testUrl), dbName);
        await adapter.init();
    });

    afterAll(async () => {
        await adapter.close();
    });

    beforeEach(async () => {
        // Clear the collections before each test
        const client = new MongoClient(testUrl);
        await client.connect();
        const db = client.db(dbName);
        await db.collection('knowledge').deleteMany({});
        await client.close();
    });

    describe('Knowledge Management', () => {
        it('should create and retrieve knowledge', async () => {
            const testKnowledge: RAGKnowledgeItem = {
                id: uuidv4() as UUID,
                agentId: uuidv4() as UUID,
                content: {
                    text: 'Test knowledge content',
                    metadata: {
                        isShared: false,
                        isMain: true
                    }
                },
                embedding: new Float32Array([0.1, 0.2, 0.3]),
                createdAt: Date.now()
            };

            await adapter.createKnowledge(testKnowledge);

            const retrieved = await adapter.getKnowledge({ id: testKnowledge.id, agentId: testKnowledge.agentId });
            expect(retrieved).toHaveLength(1);
            expect(retrieved[0].id).toBe(testKnowledge.id);
            expect(retrieved[0].content.text).toBe(testKnowledge.content.text);
        });

        it('should search knowledge by embedding', async () => {
            const testKnowledge1: RAGKnowledgeItem = {
                id: uuidv4() as UUID,
                agentId: uuidv4() as UUID,
                content: {
                    text: 'First test knowledge',
                    metadata: { isShared: false }
                },
                embedding: new Float32Array([0.1, 0.2, 0.3]),
                createdAt: Date.now()
            };

            const testKnowledge2: RAGKnowledgeItem = {
                id: uuidv4() as UUID,
                agentId: uuidv4() as UUID,
                content: {
                    text: 'Second test knowledge',
                    metadata: { isShared: false }
                },
                embedding: new Float32Array([0.4, 0.5, 0.6]),
                createdAt: Date.now()
            };

            await adapter.createKnowledge(testKnowledge1);
            await adapter.createKnowledge(testKnowledge2);

            const searchResults = await adapter.searchKnowledge({
                agentId: testKnowledge1.agentId,
                embedding: new Float32Array([0.1, 0.2, 0.3]),
                match_count: 1,
                match_threshold: 0.8
            });

            expect(searchResults).toHaveLength(1);
            expect(searchResults[0].id).toBe(testKnowledge1.id);
        });

        it('should remove knowledge', async () => {
            const testKnowledge: RAGKnowledgeItem = {
                id: uuidv4() as UUID,
                agentId: uuidv4() as UUID,
                content: {
                    text: 'Test knowledge to remove',
                    metadata: { isShared: false }
                },
                embedding: new Float32Array([0.1, 0.2, 0.3]),
                createdAt: Date.now()
            };

            await adapter.createKnowledge(testKnowledge);
            await adapter.removeKnowledge(testKnowledge.id);

            const retrieved = await adapter.getKnowledge({ id: testKnowledge.id, agentId: testKnowledge.agentId });
            expect(retrieved).toHaveLength(0);
        });
    });

    describe('Cache Operations', () => {
        it('should set and get cache', async () => {
            const agentId = uuidv4();
            const key = 'test-key';
            const value = 'test-value';

            await adapter.setCache({ key, agentId: agentId as UUID, value });
            const retrieved = await adapter.getCache({ key, agentId: agentId as UUID });

            expect(retrieved).toBe(value);
        });

        it('should delete cache', async () => {
            const agentId = uuidv4();
            const key = 'test-key';
            const value = 'test-value';

            await adapter.setCache({ key, agentId: agentId as UUID, value });
            await adapter.deleteCache({ key, agentId: agentId as UUID });

            const retrieved = await adapter.getCache({ key, agentId: agentId as UUID });
            expect(retrieved).toBeUndefined();
        });
    });
});