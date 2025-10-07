import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { MemoryService } from '../../services/memory';
import { ApiClientConfig } from '../../types/base';
import { UUID } from '@elizaos/core';

// Test UUIDs in proper format
const TEST_AGENT_ID = '550e8400-e29b-41d4-a716-446655440001' as UUID;
const TEST_ROOM_ID = '550e8400-e29b-41d4-a716-446655440002' as UUID;
const TEST_MEMORY_ID = '550e8400-e29b-41d4-a716-446655440003' as UUID;
const TEST_SERVER_ID = '550e8400-e29b-41d4-a716-446655440004' as UUID;

describe('MemoryService', () => {
  let memoryService: MemoryService;
  const mockConfig: ApiClientConfig = {
    baseUrl: 'http://localhost:3000',
    apiKey: 'test-key',
  };

  beforeEach(() => {
    memoryService = new MemoryService(mockConfig);
    // Mock the HTTP methods
    (memoryService as any).get = mock(() => Promise.resolve({}));
    (memoryService as any).post = mock(() => Promise.resolve({}));
    (memoryService as any).patch = mock(() => Promise.resolve({}));
    (memoryService as any).delete = mock(() => Promise.resolve({}));
  });

  afterEach(() => {
    const getMock = (memoryService as any).get;
    const postMock = (memoryService as any).post;
    const patchMock = (memoryService as any).patch;
    const deleteMock = (memoryService as any).delete;

    if (getMock?.mockClear) getMock.mockClear();
    if (postMock?.mockClear) postMock.mockClear();
    if (patchMock?.mockClear) patchMock.mockClear();
    if (deleteMock?.mockClear) deleteMock.mockClear();
  });

  describe('constructor', () => {
    it('should create an instance with valid configuration', () => {
      expect(memoryService).toBeInstanceOf(MemoryService);
    });

    it('should throw error when initialized with invalid configuration', () => {
      expect(() => new MemoryService(null as any)).toThrow();
    });
  });

  describe('getAgentMemories', () => {
    it('should retrieve agent memories successfully', async () => {
      const mockMemories = {
        memories: [
          { id: 'mem-1', content: 'Memory 1', timestamp: '2024-01-01T00:00:00Z' },
          { id: 'mem-2', content: 'Memory 2', timestamp: '2024-01-02T00:00:00Z' },
        ],
      };
      (memoryService as any).get.mockResolvedValue(mockMemories);

      const result = await memoryService.getAgentMemories(TEST_AGENT_ID);

      expect((memoryService as any).get).toHaveBeenCalledWith(
        `/api/memory/${TEST_AGENT_ID}/memories`,
        { params: undefined }
      );
      expect(result).toEqual(mockMemories);
    });

    it('should handle pagination parameters', async () => {
      const params = { limit: 10, offset: 20 };
      (memoryService as any).get.mockResolvedValue({ memories: [] });

      await memoryService.getAgentMemories(TEST_AGENT_ID, params);

      expect((memoryService as any).get).toHaveBeenCalledWith(
        `/api/memory/${TEST_AGENT_ID}/memories`,
        { params }
      );
    });
  });

  describe('getRoomMemories', () => {
    it('should retrieve room memories successfully', async () => {
      const mockMemories = { memories: [{ id: 'mem-1', content: 'Room memory' }] };
      (memoryService as any).get.mockResolvedValue(mockMemories);

      const result = await memoryService.getRoomMemories(TEST_AGENT_ID, TEST_ROOM_ID);

      expect((memoryService as any).get).toHaveBeenCalledWith(
        `/api/memory/${TEST_AGENT_ID}/rooms/${TEST_ROOM_ID}/memories`,
        { params: undefined }
      );
      expect(result).toEqual(mockMemories);
    });

    it('should handle memory parameters', async () => {
      const params = { limit: 5 };
      (memoryService as any).get.mockResolvedValue({ memories: [] });

      await memoryService.getRoomMemories(TEST_AGENT_ID, TEST_ROOM_ID, params);

      expect((memoryService as any).get).toHaveBeenCalledWith(
        `/api/memory/${TEST_AGENT_ID}/rooms/${TEST_ROOM_ID}/memories`,
        { params }
      );
    });
  });

  describe('updateMemory', () => {
    const updateParams = { content: 'Updated memory content' };

    it('should update memory successfully', async () => {
      const mockUpdatedMemory = { id: TEST_MEMORY_ID, content: 'Updated memory content' };
      (memoryService as any).patch.mockResolvedValue(mockUpdatedMemory);

      const result = await memoryService.updateMemory(TEST_AGENT_ID, TEST_MEMORY_ID, updateParams);

      expect((memoryService as any).patch).toHaveBeenCalledWith(
        `/api/memory/${TEST_AGENT_ID}/memories/${TEST_MEMORY_ID}`,
        updateParams
      );
      expect(result).toEqual(mockUpdatedMemory);
    });
  });

  describe('clearAgentMemories', () => {
    it('should clear agent memories successfully', async () => {
      const mockResponse = { deleted: 10 };
      (memoryService as any).delete.mockResolvedValue(mockResponse);

      const result = await memoryService.clearAgentMemories(TEST_AGENT_ID);

      expect((memoryService as any).delete).toHaveBeenCalledWith(
        `/api/memory/${TEST_AGENT_ID}/memories`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('clearRoomMemories', () => {
    it('should clear room memories successfully', async () => {
      const mockResponse = { deleted: 5 };
      (memoryService as any).delete.mockResolvedValue(mockResponse);

      const result = await memoryService.clearRoomMemories(TEST_AGENT_ID, TEST_ROOM_ID);

      expect((memoryService as any).delete).toHaveBeenCalledWith(
        `/api/memory/${TEST_AGENT_ID}/memories/all/${TEST_ROOM_ID}`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('listAgentRooms', () => {
    it('should list agent rooms successfully', async () => {
      const mockRooms = {
        rooms: [
          { id: 'room-1', name: 'Room 1' },
          { id: 'room-2', name: 'Room 2' },
        ],
      };
      (memoryService as any).get.mockResolvedValue(mockRooms);

      const result = await memoryService.listAgentRooms(TEST_AGENT_ID);

      expect((memoryService as any).get).toHaveBeenCalledWith(`/api/memory/${TEST_AGENT_ID}/rooms`);
      expect(result).toEqual(mockRooms);
    });
  });

  describe('getRoom', () => {
    it('should get room details successfully', async () => {
      const mockRoom = { id: TEST_ROOM_ID, name: 'Test Room', description: 'A test room' };
      (memoryService as any).get.mockResolvedValue(mockRoom);

      const result = await memoryService.getRoom(TEST_AGENT_ID, TEST_ROOM_ID);

      expect((memoryService as any).get).toHaveBeenCalledWith(
        `/api/memory/${TEST_AGENT_ID}/rooms/${TEST_ROOM_ID}`
      );
      expect(result).toEqual(mockRoom);
    });
  });

  describe('createRoom', () => {
    const roomParams = { name: 'New Room', description: 'A new room' };

    it('should create room successfully', async () => {
      const mockCreatedRoom = { id: 'room-new', ...roomParams };
      (memoryService as any).post.mockResolvedValue(mockCreatedRoom);

      const result = await memoryService.createRoom(TEST_AGENT_ID, roomParams);

      expect((memoryService as any).post).toHaveBeenCalledWith(
        `/api/memory/${TEST_AGENT_ID}/rooms`,
        roomParams
      );
      expect(result).toEqual(mockCreatedRoom);
    });
  });

  describe('createWorldFromServer', () => {
    const worldParams = { name: 'New World', description: 'A new world' };

    it('should create world from server successfully', async () => {
      const mockResponse = { worldId: 'world-new' as UUID };
      (memoryService as any).post.mockResolvedValue(mockResponse);

      const result = await memoryService.createWorldFromServer(TEST_SERVER_ID, worldParams);

      expect((memoryService as any).post).toHaveBeenCalledWith(
        `/api/memory/groups/${TEST_SERVER_ID}`,
        worldParams
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('deleteWorld', () => {
    it('should delete world successfully', async () => {
      const mockResponse = { success: true };
      (memoryService as any).delete.mockResolvedValue(mockResponse);

      const result = await memoryService.deleteWorld(TEST_SERVER_ID);

      expect((memoryService as any).delete).toHaveBeenCalledWith(
        `/api/memory/groups/${TEST_SERVER_ID}`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('clearWorldMemories', () => {
    it('should clear world memories successfully', async () => {
      const mockResponse = { deleted: 15 };
      (memoryService as any).delete.mockResolvedValue(mockResponse);

      const result = await memoryService.clearWorldMemories(TEST_SERVER_ID);

      expect((memoryService as any).delete).toHaveBeenCalledWith(
        `/api/memory/groups/${TEST_SERVER_ID}/memories`
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      (memoryService as any).get.mockRejectedValue(new Error('Network error'));

      await expect(memoryService.getAgentMemories(TEST_AGENT_ID)).rejects.toThrow('Network error');
    });

    it('should handle API errors', async () => {
      (memoryService as any).post.mockRejectedValue(new Error('API error'));

      await expect(memoryService.createRoom(TEST_AGENT_ID, { name: 'test' })).rejects.toThrow(
        'API error'
      );
    });
  });
});
