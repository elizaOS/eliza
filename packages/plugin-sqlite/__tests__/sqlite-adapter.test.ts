import type { Account, Actor, Character, UUID } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../src';
import { load } from '../src/sqlite_vec';

// Mock the logger
vi.mock('@elizaos/core', async () => {
    const actual = await vi.importActual<typeof import('@elizaos/core')>('@elizaos/core');
    return {
        ...actual,
        logger: {
            error: vi.fn()
        }
    };
});

// Mock sqlite_vec
vi.mock('../src/sqlite_vec', () => ({
    load: vi.fn()
}));


interface MockDatabase {
    prepare: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
}

describe('SqliteDatabaseAdapter', () => {
    let adapter: SqliteDatabaseAdapter;
    let mockDb: MockDatabase;
    const testUuid = stringToUuid('test-character-id');

    beforeEach(() => {
        // Create mock database methods
        mockDb = {
            prepare: vi.fn(() => ({
                get: vi.fn(),
                all: vi.fn(),
                run: vi.fn(),
                bind: vi.fn()
            })),
            exec: vi.fn(),
            close: vi.fn()
        };

        // Initialize adapter with mock db
        adapter = new SqliteDatabaseAdapter(mockDb as unknown as Database);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('getRoom', () => {
        it('should return room ID when room exists', async () => {
            const roomId = 'test-room-id' as UUID;
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce({ id: roomId })
            });

            const result = await adapter.getRoom(roomId);

            expect(mockDb.prepare).toHaveBeenCalledWith('SELECT id FROM rooms WHERE id = ?');
            expect(result).toBe(roomId);
        });

        it('should return null when room does not exist', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce(undefined)
            });

            const result = await adapter.getRoom('non-existent-room' as UUID);

            expect(result).toBeNull();
        });
    });

    describe('getParticipantsForAccount', () => {
        const mockParticipants = [
            { id: 'participant-1', userId: 'user-1', roomId: 'room-1' },
            { id: 'participant-2', userId: 'user-1', roomId: 'room-2' }
        ];

        it('should return participants when they exist', async () => {
            mockDb.prepare.mockReturnValueOnce({
                all: vi.fn().mockReturnValueOnce(mockParticipants)
            });

            const userId = 'user-1' as UUID;
            const result = await adapter.getParticipantsForAccount(userId);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT p.id, p.userId, p.roomId'));
            expect(result).toEqual(mockParticipants);
        });

        it('should return empty array when no participants exist', async () => {
            mockDb.prepare.mockReturnValueOnce({
                all: vi.fn().mockReturnValueOnce([])
            });

            const result = await adapter.getParticipantsForAccount('no-participants' as UUID);

            expect(result).toEqual([]);
        });
    });

    describe('getParticipantUserState', () => {
        const roomId = 'test-room' as UUID;
        const userId = 'test-user' as UUID;

        it('should return user state when it exists', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce({ userState: 'FOLLOWED' })
            });

            const result = await adapter.getParticipantUserState(roomId, userId);

            expect(mockDb.prepare).toHaveBeenCalledWith(
                'SELECT userState FROM participants WHERE roomId = ? AND userId = ?'
            );
            expect(result).toBe('FOLLOWED');
        });

        it('should return null when user state does not exist', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce(undefined)
            });

            const result = await adapter.getParticipantUserState(roomId, userId);

            expect(result).toBeNull();
        });
    });

    describe('setParticipantUserState', () => {
        const roomId = 'test-room' as UUID;
        const userId = 'test-user' as UUID;

        it('should successfully update user state', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            await adapter.setParticipantUserState(roomId, userId, 'MUTED');

            expect(mockDb.prepare).toHaveBeenCalledWith(
                'UPDATE participants SET userState = ? WHERE roomId = ? AND userId = ?'
            );
            expect(runMock).toHaveBeenCalledWith('MUTED', roomId, userId);
        });

        it('should handle null state', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            await adapter.setParticipantUserState(roomId, userId, null);

            expect(runMock).toHaveBeenCalledWith(null, roomId, userId);
        });
    });

    describe('init and close', () => {
        it('should initialize the database with tables', async () => {
            await adapter.init();
            expect(mockDb.exec).toHaveBeenCalled();
            expect(load).toHaveBeenCalledWith(mockDb);
        });

        it('should close the database connection', async () => {
            await adapter.close();
            expect(mockDb.close).toHaveBeenCalled();
        });
    });

    describe('createAccount', () => {
        it('should create an account successfully', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            const account: Account = {
                id: 'test-id' as UUID,
                name: 'Test User',
                username: 'testuser',
                email: 'test@example.com',
                avatarUrl: 'https://example.com/avatar.png'
            };

            const result = await adapter.createAccount(account);

            expect(mockDb.prepare).toHaveBeenCalledWith(
                'INSERT INTO accounts (id, name, username, email, avatarUrl) VALUES (?, ?, ?, ?, ?)'
            );
            expect(runMock).toHaveBeenCalledWith(
                account.id,
                account.name,
                account.username,
                account.email,
                account.avatarUrl
            );
            expect(result).toBe(true);
        });

        it('should handle errors when creating account', async () => {
            mockDb.prepare.mockReturnValueOnce({
                run: vi.fn().mockImplementationOnce(() => {
                    throw new Error('Database error');
                })
            });

            const account: Account = {
                id: 'test-id' as UUID,
                name: 'Test User',
                username: 'testuser',
                email: 'test@example.com',
                avatarUrl: 'https://example.com/avatar.png'
            };

            const result = await adapter.createAccount(account);
            expect(result).toBe(false);
        });
    });

    describe('getActorDetails', () => {
        it('should return actor details', async () => {
            const mockActors: Actor[] = [
                { id: 'actor-1' as UUID, name: 'Actor 1', username: 'actor1' },
                { id: 'actor-2' as UUID, name: 'Actor 2', username: 'actor2' }
            ];

            mockDb.prepare.mockReturnValueOnce({
                all: vi.fn().mockReturnValueOnce(mockActors)
            });

            const result = await adapter.getActorDetails({ roomId: 'room-1' as UUID });

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT a.id, a.name, a.username'));
            expect(result).toEqual(mockActors);
        });

        it('should filter out null actors', async () => {
            mockDb.prepare.mockReturnValueOnce({
                all: vi.fn().mockReturnValueOnce([null, { id: 'actor-1' as UUID, name: 'Actor 1', username: 'actor1' }, null])
            });

            const result = await adapter.getActorDetails({ roomId: 'room-1' as UUID });

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ id: 'actor-1', name: 'Actor 1', username: 'actor1' });
        });
    });

    describe('getMemoryById', () => {
        it('should return memory when it exists', async () => {
            const mockMemory = {
                id: 'memory-1' as UUID,
                content: JSON.stringify({ text: 'Test memory' })
            };

            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce(mockMemory),
                bind: vi.fn()
            });

            const result = await adapter.getMemoryById('memory-1' as UUID);

            expect(mockDb.prepare).toHaveBeenCalledWith('SELECT * FROM memories WHERE id = ?');
            expect(result).toEqual({
                ...mockMemory,
                content: { text: 'Test memory' }
            });
        });

        it('should return null when memory does not exist', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce(undefined),
                bind: vi.fn()
            });

            const result = await adapter.getMemoryById('non-existent' as UUID);
            expect(result).toBeNull();
        });
    });

    describe('Character operations', () => {
        const mockCharacter: Required<Pick<Character, 'id' | 'name' | 'bio' | 'lore' | 'messageExamples' | 'postExamples' | 'topics' | 'adjectives' | 'style'>> = {
            id: testUuid,
            name: 'Test Character',
            bio: 'Test Bio',
            lore: ['Test lore'],
            messageExamples: [[]],
            postExamples: ['Test post'],
            topics: ['Test topic'],
            adjectives: ['Test adjective'],
            style: {
                all: ['Test style'],
                chat: ['Test chat style'],
                post: ['Test post style']
            }
        };

        it('should create a character', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            await adapter.createCharacter(mockCharacter);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO characters'));
            expect(runMock).toHaveBeenCalledWith(
                mockCharacter.id,
                mockCharacter.name,
                mockCharacter.bio,
                JSON.stringify(mockCharacter)
            );
        });

        it('should create a character with generated UUID', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            const characterWithoutId: Omit<typeof mockCharacter, 'id'> = {
                name: mockCharacter.name,
                bio: mockCharacter.bio,
                lore: mockCharacter.lore,
                messageExamples: mockCharacter.messageExamples,
                postExamples: mockCharacter.postExamples,
                topics: mockCharacter.topics,
                adjectives: mockCharacter.adjectives,
                style: mockCharacter.style
            };

            await adapter.createCharacter(characterWithoutId as Character);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO characters'));
            expect(runMock).toHaveBeenCalledWith(
                expect.any(String),
                characterWithoutId.name,
                characterWithoutId.bio,
                expect.any(String)
            );
        });

        it('should update a character', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            await adapter.updateCharacter(mockCharacter);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE characters'));
            expect(runMock).toHaveBeenCalledWith(
                mockCharacter.name,
                mockCharacter.bio,
                JSON.stringify(mockCharacter),
                mockCharacter.id
            );
        });

        it('should get a character', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce(mockCharacter)
            });

            const result = await adapter.getCharacter(mockCharacter.id);

            expect(mockDb.prepare).toHaveBeenCalledWith('SELECT * FROM characters WHERE id = ?');
            expect(result).toEqual(mockCharacter);
        });

        it('should return null when getting non-existent character', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce(null)
            });

            const result = await adapter.getCharacter(testUuid);

            expect(mockDb.prepare).toHaveBeenCalledWith('SELECT * FROM characters WHERE id = ?');
            expect(result).toBeNull();
        });

        it('should remove a character', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            await adapter.removeCharacter(mockCharacter.id);

            expect(mockDb.prepare).toHaveBeenCalledWith('DELETE FROM characters WHERE id = ?');
            expect(runMock).toHaveBeenCalledWith(mockCharacter.id);
        });

        it('should list all characters', async () => {
            const mockCharacters = [mockCharacter];
            mockDb.prepare.mockReturnValueOnce({
                all: vi.fn().mockReturnValueOnce(mockCharacters)
            });

            const result = await adapter.listCharacters();

            expect(mockDb.prepare).toHaveBeenCalledWith('SELECT * FROM characters');
            expect(result).toEqual(mockCharacters);
        });

        it('should import a character', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            await adapter.importCharacter(mockCharacter);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO characters'));
            expect(runMock).toHaveBeenCalledWith(
                mockCharacter.id,
                mockCharacter.name,
                mockCharacter.bio,
                JSON.stringify(mockCharacter)
            );
        });

        it('should export a character', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce(mockCharacter)
            });

            const result = await adapter.exportCharacter(mockCharacter.id);

            expect(mockDb.prepare).toHaveBeenCalledWith('SELECT * FROM characters WHERE id = ?');
            expect(result).toEqual(mockCharacter);
        });
    });

    describe('Cache operations', () => {
        const mockParams = {
            key: 'test-key',
            agentId: 'agent-1' as UUID,
            value: 'test-value'
        };

        it('should set cache value', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            const result = await adapter.setCache(mockParams);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR REPLACE INTO cache'));
            expect(runMock).toHaveBeenCalledWith(mockParams.key, mockParams.agentId, mockParams.value);
            expect(result).toBe(true);
        });

        it('should get cache value', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce({ value: mockParams.value })
            });

            const result = await adapter.getCache({
                key: mockParams.key,
                agentId: mockParams.agentId
            });

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT value FROM cache'));
            expect(result).toBe(mockParams.value);
        });

        it('should delete cache value', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            const result = await adapter.deleteCache({
                key: mockParams.key,
                agentId: mockParams.agentId
            });

            expect(mockDb.prepare).toHaveBeenCalledWith('DELETE FROM cache WHERE key = ? AND agentId = ?');
            expect(runMock).toHaveBeenCalledWith(mockParams.key, mockParams.agentId);
            expect(result).toBe(true);
        });
    });
});
