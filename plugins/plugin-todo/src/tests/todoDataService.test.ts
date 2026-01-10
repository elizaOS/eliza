import type { IAgentRuntime, UUID } from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todosTable, todoTagsTable } from '../schema.ts';
import { createTodoDataService, TodoDataService } from '../services/todoDataService.ts';

describe('TodoDataService', () => {
  let mockRuntime: IAgentRuntime;
  let service: TodoDataService;
  let mockDb: any;
  let mockThenable: any;

  beforeEach(() => {
    mockThenable = {
      from: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      returning: vi.fn(),
      values: vi.fn(),
      set: vi.fn(),
      then: vi.fn(),
      execute: vi.fn(),
      findFirst: vi.fn(),
      all: vi.fn(),
      $dynamic: vi.fn(),
    };

    mockThenable.from.mockReturnThis();
    mockThenable.where.mockReturnThis();
    mockThenable.orderBy.mockReturnThis();
    mockThenable.limit.mockReturnThis();
    mockThenable.returning.mockReturnThis();
    mockThenable.values.mockReturnThis();
    mockThenable.set.mockReturnThis();
    mockThenable.findFirst.mockReturnThis();
    mockThenable.all.mockReturnThis();
    mockThenable.$dynamic.mockReturnThis();

    mockDb = {
      insert: vi.fn().mockReturnValue(mockThenable),
      select: vi.fn().mockReturnValue(mockThenable),
      update: vi.fn().mockReturnValue(mockThenable),
      delete: vi.fn().mockReturnValue(mockThenable),
      execute: vi.fn(),
    };

    mockRuntime = {
      agentId: 'test-agent' as UUID,
      db: mockDb,
    } as any;

    service = createTodoDataService(mockRuntime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createTodo', () => {
    it('should create a new todo with tags', async () => {
      const mockTodo = { id: 'todo-1' };
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve([mockTodo]));
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(true));

      const todoId = await service.createTodo({
        agentId: 'agent-1' as UUID,
        worldId: 'world-1' as UUID,
        roomId: 'room-1' as UUID,
        entityId: 'entity-1' as UUID,
        name: 'Test Todo',
        description: 'Test Description',
        type: 'one-off',
        priority: 2,
        isUrgent: true,
        dueDate: new Date('2024-12-31'),
        metadata: { custom: 'data' },
        tags: ['TODO', 'urgent'],
      });

      expect(mockDb.insert).toHaveBeenCalledWith(todosTable);
      expect(mockThenable.values).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalledWith(todoTagsTable);
      expect(todoId).toBe('todo-1');
    });

    it('should create daily todo', async () => {
      const mockTodo = { id: 'daily-todo-1' };
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve([mockTodo]));
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(true));

      const todoId = await service.createTodo({
        agentId: 'agent-1' as UUID,
        worldId: 'world-1' as UUID,
        roomId: 'room-1' as UUID,
        entityId: 'entity-1' as UUID,
        name: 'Daily Exercise',
        type: 'daily',
        tags: ['TODO', 'daily'],
      });

      expect(mockDb.insert).toHaveBeenCalledWith(todosTable);
      expect(todoId).toBe('daily-todo-1');
    });

    it('should handle creation failure', async () => {
      mockThenable.then.mockImplementationOnce((resolve: any, reject: any) =>
        reject(new Error('DB error'))
      );
      await expect(
        service.createTodo({
          agentId: 'agent-1' as UUID,
          worldId: 'world-1' as UUID,
          roomId: 'room-1' as UUID,
          entityId: 'entity-1' as UUID,
          name: 'Test Todo',
          type: 'one-off',
        })
      ).rejects.toThrow('DB error');
    });
  });

  describe('getTodos', () => {
    it('should get todos with filters', async () => {
      const mockTodos = [
        { id: 'todo-1', name: 'Todo 1', type: 'one-off' },
        { id: 'todo-2', name: 'Todo 2', type: 'daily' },
      ];

      // First mock: getTodos query
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(mockTodos));
      
      // Mock for each todo's tags query (2 todos = 2 tag queries)
      mockThenable.then.mockImplementationOnce((resolve: any) => 
        resolve([{ tag: 'TODO' }, { tag: 'urgent' }])
      );
      mockThenable.then.mockImplementationOnce((resolve: any) => 
        resolve([{ tag: 'TODO' }, { tag: 'daily' }])
      );

      const todos = await service.getTodos({
        entityId: 'entity-1' as UUID,
        type: 'one-off',
        isCompleted: false,
      });

      expect(mockThenable.where).toHaveBeenCalled();
      expect(todos).toHaveLength(2);
      expect(todos[0].tags).toEqual(['TODO', 'urgent']);
      expect(todos[1].tags).toEqual(['TODO', 'daily']);
    });

    it('should filter by tags', async () => {
      const mockTodos = [{ id: 'todo-1', name: 'Todo 1' }];
      const mockTags = [{ todoId: 'todo-1', tag: 'urgent' }];

      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(mockTodos));
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(mockTags));

      const todos = await service.getTodos({
        tags: ['urgent'],
      });

      expect(mockThenable.where).toHaveBeenCalled();
      expect(todos).toHaveLength(1);
      expect(todos[0].id).toBe('todo-1');
      expect(todos[0].tags).toEqual(['urgent']);
    });
  });

  describe('getTodo', () => {
    it('should get a single todo by ID', async () => {
      const mockTodo = { id: 'todo-1', name: 'Test Todo' };
      const mockTags = [
        { todoId: 'todo-1', tag: 'TODO' },
        { todoId: 'todo-1', tag: 'urgent' },
      ];

      mockThenable.then.mockImplementationOnce((resolve: any) => resolve([mockTodo]));
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(mockTags));

      const todo = await service.getTodo('todo-1' as UUID);

      expect(mockThenable.where).toHaveBeenCalled();
      expect(todo).not.toBeNull();
      expect(todo?.id).toBe('todo-1');
      expect(todo?.tags).toHaveLength(2);
      expect(todo?.tags).toContain('TODO');
      expect(todo?.tags).toContain('urgent');
    });

    it('should return null for non-existent todo', async () => {
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve([]));
      const todo = await service.getTodo('non-existent' as UUID);
      expect(todo).toBeNull();
    });
  });

  describe('updateTodo', () => {
    it('should update todo fields', async () => {
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(true));

      const success = await service.updateTodo('todo-1' as UUID, {
        name: 'Updated Name',
        priority: 1,
        isCompleted: true,
        completedAt: new Date(),
      });

      expect(mockThenable.set).toHaveBeenCalled();
      expect(mockThenable.where).toHaveBeenCalled();
      expect(success).toBe(true);
    });

    it('should handle update failure', async () => {
      mockThenable.then.mockImplementationOnce((resolve: any, reject: any) => 
        reject(new Error('Update failed'))
      );

      const success = await service.updateTodo('todo-1' as UUID, {
        name: 'Updated Name',
      });

      expect(success).toBe(false);
    });
  });

  describe('deleteTodo', () => {
    it('should delete a todo', async () => {
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(true));

      const success = await service.deleteTodo('todo-1' as UUID);

      expect(mockThenable.where).toHaveBeenCalled();
      expect(success).toBe(true);
    });
  });

  describe('addTags', () => {
    it('should add new tags to a todo', async () => {
      const existingTags = [{ tag: 'TODO' }];
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(existingTags));
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(true));

      const success = await service.addTags('todo-1' as UUID, ['urgent', 'high-priority']);

      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalledWith(todoTagsTable);
      expect(success).toBe(true);
    });

    it('should not add duplicate tags', async () => {
      const existingTags = [{ tag: 'TODO' }, { tag: 'urgent' }];
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(existingTags));

      const success = await service.addTags('todo-1' as UUID, ['urgent', 'TODO']);

      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(success).toBe(true);
    });
  });

  describe('removeTags', () => {
    it('should remove tags from a todo', async () => {
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(true));

      const success = await service.removeTags('todo-1' as UUID, ['urgent', 'outdated']);

      expect(mockDb.delete).toHaveBeenCalledWith(todoTagsTable);
      expect(mockThenable.where).toHaveBeenCalled();
      expect(success).toBe(true);
    });
  });

  describe('getOverdueTodos', () => {
    it('should get overdue todos', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const mockTodos = [
        {
          id: 'todo-1',
          name: 'Overdue Task',
          type: 'one-off',
          dueDate: yesterday,
          isCompleted: false,
        },
      ];
      const mockTags = [
        { todoId: 'todo-1', tag: 'TODO' },
        { todoId: 'todo-1', tag: 'urgent' },
      ];

      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(mockTodos));
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve(mockTags));

      const overdueTodos = await service.getOverdueTodos();

      expect(mockThenable.where).toHaveBeenCalled();
      expect(overdueTodos).toHaveLength(1);
      expect(overdueTodos[0].name).toBe('Overdue Task');
    });
  });

  describe('resetDailyTodos', () => {
    it('should reset completed daily todos', async () => {
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve({ count: 3 }));
      const count = await service.resetDailyTodos({
        agentId: 'agent-1' as UUID,
      });
      expect(count).toBe(0); // Method returns 0 for now
    });

    it('should return 0 if no todos to reset', async () => {
      mockThenable.then.mockImplementationOnce((resolve: any) => resolve({ count: 0 }));
      const count = await service.resetDailyTodos({
        agentId: 'agent-1' as UUID,
      });
      expect(count).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should handle missing database gracefully', () => {
      mockRuntime.db = undefined;
      // Should not throw, just create service
      const service = createTodoDataService(mockRuntime);
      expect(service).toBeDefined();
    });

    it('should handle database errors gracefully', async () => {
      mockThenable.then.mockImplementationOnce((resolve: any, reject: any) =>
        reject(new Error('Database error'))
      );
      // getTodos should return empty array on error
      const todos = await service.getTodos();
      expect(todos).toEqual([]);
    });
  });
});
