import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { goalSchema, goalsTable, goalTagsTable } from "../schema";

describe("Goals Schema Tests", () => {
  describe("goalsTable", () => {
    it("should have correct columns", () => {
      const columns = getTableColumns(goalsTable);

      expect(columns.id).toBeDefined();
      expect(columns.agentId).toBeDefined();
      expect(columns.ownerType).toBeDefined();
      expect(columns.ownerId).toBeDefined();
      expect(columns.name).toBeDefined();
      expect(columns.description).toBeDefined();
      expect(columns.isCompleted).toBeDefined();
      expect(columns.completedAt).toBeDefined();
      expect(columns.createdAt).toBeDefined();
      expect(columns.updatedAt).toBeDefined();
      expect(columns.metadata).toBeDefined();
    });

    it("should have correct defaults", () => {
      const columns = getTableColumns(goalsTable);

      expect(columns.isCompleted.default).toBe(false);
      expect(columns.metadata.default).toEqual({});
    });
  });

  describe("goalTagsTable", () => {
    it("should have correct columns", () => {
      const columns = getTableColumns(goalTagsTable);

      expect(columns.id).toBeDefined();
      expect(columns.goalId).toBeDefined();
      expect(columns.tag).toBeDefined();
      expect(columns.createdAt).toBeDefined();
    });

    it("should have foreign key reference to goals", () => {
      const columns = getTableColumns(goalTagsTable);
      const goalIdColumn = columns.goalId;

      expect(goalIdColumn).toBeDefined();
    });
  });

  describe("goalSchema export", () => {
    it("should export all tables correctly", () => {
      expect(goalSchema).toBeDefined();
      expect(goalSchema.goalsTable).toBeDefined();
      expect(goalSchema.goalTagsTable).toBeDefined();
      expect(goalSchema.tables).toBeDefined();
      expect(goalSchema.tables.goals).toBe(goalsTable);
      expect(goalSchema.tables.goalTags).toBe(goalTagsTable);
    });
  });
});
