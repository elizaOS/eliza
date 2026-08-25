import { describe, expect, it, vi } from "vitest";
import type { LifeOpsTaskDefinition } from "../../contracts/index.js";
import {
  applySeedRoutineMigration,
  buildSeedRoutineMigrationDiff,
} from "./migrator";

interface FakeDefinition {
  id: string;
  title: string;
  metadata: Record<string, unknown>;
}

function legacyDefinition(
  overrides: Partial<FakeDefinition> = {},
): FakeDefinition {
  return {
    id: "def-1",
    title: "Brush teeth",
    metadata: { seedKey: "load-test-user-profile:brush_teeth" },
    ...overrides,
  };
}

function makeReader(definitions: FakeDefinition[]) {
  const listDefinitions = vi.fn().mockResolvedValue(definitions);
  const updateDefinitionMetadata = vi.fn().mockResolvedValue(undefined);
  return { listDefinitions, updateDefinitionMetadata };
}

function makeSink() {
  const schedule = vi.fn().mockResolvedValue({ taskId: "task-1" });
  return { schedule };
}

describe("buildSeedRoutineMigrationDiff", () => {
  it("is a pure dry-run: never writes or schedules", async () => {
    const reader = makeReader([legacyDefinition()]);
    const sink = makeSink();
    const diff = await buildSeedRoutineMigrationDiff({
      agentId: "agent-1",
      reader,
    });
    expect(diff.candidates).toHaveLength(1);
    expect(sink.schedule).not.toHaveBeenCalled();
    expect(reader.updateDefinitionMetadata).not.toHaveBeenCalled();
  });

  it("maps a legacy seed key to the matching habit starter", async () => {
    const reader = makeReader([legacyDefinition()]);
    const diff = await buildSeedRoutineMigrationDiff({
      agentId: "agent-1",
      reader,
    });
    expect(diff.candidates).toEqual([
      expect.objectContaining({
        definitionId: "def-1",
        title: "Brush teeth",
        habitStarterKey: "brush_teeth",
        idempotencyKey: "load-test-user-profile:brush_teeth",
        alreadyMigrated: false,
      }),
    ]);
    expect(diff.legacyDefinitionsWithoutMatch).toEqual([]);
  });

  it("ignores definitions without a legacy seed-key marker", async () => {
    const reader = makeReader([
      legacyDefinition({ id: "def-2", metadata: {} }),
      legacyDefinition({ id: "def-3", metadata: { seedKey: "other:key" } }),
    ]);
    const diff = await buildSeedRoutineMigrationDiff({
      agentId: "agent-1",
      reader,
    });
    expect(diff.candidates).toEqual([]);
    expect(diff.legacyDefinitionsWithoutMatch).toEqual([]);
  });

  it("reports prefixed seed keys with no matching habit starter as orphans", async () => {
    const reader = makeReader([
      legacyDefinition({
        id: "def-4",
        metadata: { seedKey: "load-test-user-profile:no_such_habit" },
      }),
    ]);
    const diff = await buildSeedRoutineMigrationDiff({
      agentId: "agent-1",
      reader,
    });
    expect(diff.candidates).toEqual([]);
    expect(diff.legacyDefinitionsWithoutMatch).toEqual([
      {
        definitionId: "def-4",
        title: "Brush teeth",
        seedKey: "load-test-user-profile:no_such_habit",
      },
    ]);
  });

  it("flags already-migrated definitions from the stamp", async () => {
    const reader = makeReader([
      legacyDefinition({
        metadata: {
          seedKey: "load-test-user-profile:brush_teeth",
          migratedToScheduledTaskId: "task-9",
        },
      }),
    ]);
    const diff = await buildSeedRoutineMigrationDiff({
      agentId: "agent-1",
      reader,
    });
    expect(diff.candidates[0].alreadyMigrated).toBe(true);
  });

  it("stamps the diff with agent id and generation time", async () => {
    const reader = makeReader([]);
    const now = new Date("2026-08-25T00:00:00.000Z");
    const diff = await buildSeedRoutineMigrationDiff({
      agentId: "agent-7",
      reader,
      now,
    });
    expect(diff.agentId).toBe("agent-7");
    expect(diff.generatedAt).toBe(now.toISOString());
  });
});

describe("applySeedRoutineMigration", () => {
  it("schedules each candidate through the sink with the legacy idempotency key", async () => {
    const reader = makeReader([legacyDefinition()]);
    const sink = makeSink();
    await applySeedRoutineMigration({ agentId: "agent-1", reader, sink });
    expect(sink.schedule).toHaveBeenCalledTimes(1);
    const seed = sink.schedule.mock.calls[0][0] as {
      idempotencyKey: string;
      metadata: Record<string, unknown>;
    };
    expect(seed.idempotencyKey).toBe("load-test-user-profile:brush_teeth");
    expect(seed.metadata.migratedFromLegacyDefinitionId).toBe("def-1");
    expect(seed.metadata.migratedFromSeedKey).toBe(
      "load-test-user-profile:brush_teeth",
    );
  });

  it("stamps migratedToScheduledTaskId and migratedAt on the definition", async () => {
    const reader = makeReader([legacyDefinition()]);
    const sink = makeSink();
    await applySeedRoutineMigration({ agentId: "agent-1", reader, sink });
    expect(reader.updateDefinitionMetadata).toHaveBeenCalledTimes(1);
    const [definition, metadata] = reader.updateDefinitionMetadata.mock
      .calls[0] as [FakeDefinition, Record<string, unknown>];
    expect(definition.id).toBe("def-1");
    expect(metadata.migratedToScheduledTaskId).toBe("task-1");
    expect(metadata.migratedAt).toBeDefined();
  });

  it("skips already-migrated candidates without calling the sink", async () => {
    const reader = makeReader([
      legacyDefinition({
        metadata: {
          seedKey: "load-test-user-profile:brush_teeth",
          migratedToScheduledTaskId: "task-9",
        },
      }),
    ]);
    const sink = makeSink();
    const result = await applySeedRoutineMigration({
      agentId: "agent-1",
      reader,
      sink,
    });
    expect(sink.schedule).not.toHaveBeenCalled();
    expect(reader.updateDefinitionMetadata).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      { definitionId: "def-1", reason: "already_migrated" },
    ]);
    expect(result.scheduled).toEqual([]);
  });

  it("reports orphans as skipped without scheduling", async () => {
    const reader = makeReader([
      legacyDefinition({
        id: "def-5",
        metadata: { seedKey: "load-test-user-profile:no_such_habit" },
      }),
    ]);
    const sink = makeSink();
    const result = await applySeedRoutineMigration({
      agentId: "agent-1",
      reader,
      sink,
    });
    expect(sink.schedule).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      { definitionId: "def-5", reason: "no_matching_habit_starter" },
    ]);
  });

  it("collects scheduled results with task ids", async () => {
    const reader = makeReader([legacyDefinition()]);
    const sink = makeSink();
    const result = await applySeedRoutineMigration({
      agentId: "agent-1",
      reader,
      sink,
    });
    expect(result.scheduled).toEqual([
      {
        definitionId: "def-1",
        idempotencyKey: "load-test-user-profile:brush_teeth",
        habitStarterKey: "brush_teeth",
        scheduledTaskId: "task-1",
      },
    ]);
    expect(result.agentId).toBe("agent-1");
    expect(result.appliedAt).toBeDefined();
  });

  it("stamps definitions found only through the caller-provided index", async () => {
    const definitions = [legacyDefinition()];
    const reader = makeReader(definitions);
    const sink = makeSink();
    const definitionsById = new Map<string, LifeOpsTaskDefinition>(
      definitions.map((d) => [d.id, d as LifeOpsTaskDefinition]),
    );
    await applySeedRoutineMigration({
      agentId: "agent-1",
      reader,
      sink,
      definitionsById,
    });
    expect(reader.listDefinitions).toHaveBeenCalledTimes(1);
    expect(reader.updateDefinitionMetadata).toHaveBeenCalledTimes(1);
  });
});
