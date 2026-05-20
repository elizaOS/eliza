/**
 * RelationshipEvolutionEngine Simulation Mode Tests
 *
 * Tests that RelationshipEvolutionEngine methods correctly return early
 * in simulation mode to avoid raw Drizzle DB calls that would fail in JSON mode.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the simulation mode check BEFORE importing the engine
const mockIsSimulationMode = mock(() => true);
mock.module("../storage-bridge", () => ({
  isSimulationMode: mockIsSimulationMode,
}));

// Mock DB to verify no calls are made
const mockDbSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => ({
      orderBy: mock(() => ({
        limit: mock(() => Promise.resolve([])),
      })),
      limit: mock(() => Promise.resolve([])),
    })),
  })),
}));

const mockDbInsert = mock(() => ({
  values: mock(() => Promise.resolve()),
}));

const mockDbUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

mock.module("@feed/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
  actorRelationships: {},
  npcInteractions: {},
  and: () => {},
  or: () => {},
  eq: () => {},
  gte: () => {},
  desc: () => {},
}));

mock.module("@feed/shared", () => ({
  generateSnowflakeId: mock(() => Promise.resolve("test-id-123")),
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
    error: mock(() => {}),
  },
}));

// Now import the engine
import { RelationshipEvolutionEngine } from "../RelationshipEvolutionEngine";

describe("RelationshipEvolutionEngine - Simulation Mode", () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockDbSelect.mockClear();
    mockDbInsert.mockClear();
    mockDbUpdate.mockClear();
    mockIsSimulationMode.mockImplementation(() => true);
  });

  describe("generateInitialRelationships", () => {
    test("returns 0 in simulation mode without DB calls", async () => {
      const engine = new RelationshipEvolutionEngine();
      const result = await engine.generateInitialRelationships([], []);

      expect(result).toBe(0);
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockDbInsert).not.toHaveBeenCalled();
    });
  });

  describe("trackInteraction", () => {
    test("returns early in simulation mode without DB calls", async () => {
      const engine = new RelationshipEvolutionEngine();
      await engine.trackInteraction({
        actor1Id: "actor1",
        actor2Id: "actor2",
        type: "mention",
        sentiment: 0.5,
        context: "test interaction",
      });

      expect(mockDbInsert).not.toHaveBeenCalled();
    });
  });

  describe("analyzeAndUpdateRelationships", () => {
    test("returns 0 in simulation mode without DB calls", async () => {
      const engine = new RelationshipEvolutionEngine();
      const result = await engine.analyzeAndUpdateRelationships();

      expect(result).toBe(0);
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockDbUpdate).not.toHaveBeenCalled();
    });
  });

  describe("getRelationshipContextForActor", () => {
    test("returns empty string in simulation mode without DB calls", async () => {
      const engine = new RelationshipEvolutionEngine();
      const result = await engine.getRelationshipContextForActor("actor1");

      expect(result).toBe("");
      expect(mockDbSelect).not.toHaveBeenCalled();
    });
  });

  describe("getActorRelationships (static)", () => {
    test("returns empty array in simulation mode without DB calls", async () => {
      const result =
        await RelationshipEvolutionEngine.getActorRelationships("actor1");

      expect(result).toEqual([]);
      expect(mockDbSelect).not.toHaveBeenCalled();
    });
  });

  describe("getRelationship (static)", () => {
    test("returns null in simulation mode without DB calls", async () => {
      const result = await RelationshipEvolutionEngine.getRelationship(
        "actor1",
        "actor2",
      );

      expect(result).toBeNull();
      expect(mockDbSelect).not.toHaveBeenCalled();
    });
  });
});

describe("RelationshipEvolutionEngine - Non-Simulation Mode", () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockDbSelect.mockClear();
    mockDbInsert.mockClear();
    mockDbUpdate.mockClear();
    mockIsSimulationMode.mockImplementation(() => false);
  });

  describe("getActorRelationships (static)", () => {
    test("calls DB in non-simulation mode", async () => {
      // This will throw because our mock doesn't return a proper array,
      // but the important thing is that the DB SELECT was called
      try {
        await RelationshipEvolutionEngine.getActorRelationships("actor1");
      } catch {
        // Expected - mock doesn't return proper array
      }

      // DB should be called when not in simulation mode
      expect(mockDbSelect).toHaveBeenCalled();
    });
  });

  describe("getRelationship (static)", () => {
    test("calls DB in non-simulation mode", async () => {
      await RelationshipEvolutionEngine.getRelationship("actor1", "actor2");

      // DB should be called when not in simulation mode
      expect(mockDbSelect).toHaveBeenCalled();
    });
  });
});
