import type { UUID } from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../src';
import { load } from '../src/sqlite_vec';
import type { Database } from 'better-sqlite3';

// Mock the elizaLogger
vi.mock('@elizaos/core', async () => {
    const actual = await vi.importActual('@elizaos/core');
    return {
        ...actual as any,
        elizaLogger: {
            error: vi.fn()
        }
    };
});

// Mock sqlite_vec
vi.mock('../src/sqlite_vec', () => ({
    load: vi.fn()
}));

describe('SqliteDatabaseAdapter', () => {
    let adapter: SqliteDatabaseAdapter;
    let mockDb: any;

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
        adapter = new SqliteDatabaseAdapter(mockDb as Database);
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
});
