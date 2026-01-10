import { describe, expect, it } from 'vitest';
import {
  todosTable,
  todoTagsTable,
  todoSchema,
} from '../schema';
import { getTableColumns } from 'drizzle-orm';

describe('Todo Schema', () => {
  describe('todosTable', () => {
    it('should have all required columns', () => {
      const columns = getTableColumns(todosTable);

      // Core columns
      expect(columns.id).toBeDefined();
      expect(columns.agentId).toBeDefined();
      expect(columns.worldId).toBeDefined();
      expect(columns.roomId).toBeDefined();
      expect(columns.entityId).toBeDefined();

      // Task details
      expect(columns.name).toBeDefined();
      expect(columns.description).toBeDefined();
      expect(columns.type).toBeDefined();
      expect(columns.priority).toBeDefined();
      expect(columns.isUrgent).toBeDefined();
      expect(columns.isCompleted).toBeDefined();

      // Dates
      expect(columns.dueDate).toBeDefined();
      expect(columns.completedAt).toBeDefined();
      expect(columns.createdAt).toBeDefined();
      expect(columns.updatedAt).toBeDefined();

      // Metadata
      expect(columns.metadata).toBeDefined();
    });

    it('should have proper column types', () => {
      const columns = getTableColumns(todosTable);

      // UUID columns
      expect(columns.id.dataType).toBe('string');
      expect(columns.agentId.dataType).toBe('string');
      expect(columns.worldId.dataType).toBe('string');
      expect(columns.roomId.dataType).toBe('string');
      expect(columns.entityId.dataType).toBe('string');

      // Text columns
      expect(columns.name.dataType).toBe('string');
      expect(columns.type.dataType).toBe('string');

      // Boolean columns
      expect(columns.isUrgent.dataType).toBe('boolean');
      expect(columns.isCompleted.dataType).toBe('boolean');

      // Date columns
      expect(columns.createdAt.dataType).toBe('date');
      expect(columns.updatedAt.dataType).toBe('date');
    });
  });

  describe('todoTagsTable', () => {
    it('should have all required columns', () => {
      const columns = getTableColumns(todoTagsTable);

      expect(columns.id).toBeDefined();
      expect(columns.todoId).toBeDefined();
      expect(columns.tag).toBeDefined();
      expect(columns.createdAt).toBeDefined();
    });

    it('should have proper column types', () => {
      const columns = getTableColumns(todoTagsTable);

      expect(columns.id.dataType).toBe('string');
      expect(columns.todoId.dataType).toBe('string');
      expect(columns.tag.dataType).toBe('string');
      expect(columns.createdAt.dataType).toBe('date');
    });
  });

  describe('todoSchema export', () => {
    it('should export correct schema structure', () => {
      expect(todoSchema).toBeDefined();
      expect(todoSchema.todosTable).toBeDefined();
      expect(todoSchema.todoTagsTable).toBeDefined();

      // Verify tables property for compatibility
      expect(todoSchema.tables).toBeDefined();
      expect(todoSchema.tables.todos).toBeDefined();
      expect(todoSchema.tables.todoTags).toBeDefined();
    });
  });
});
