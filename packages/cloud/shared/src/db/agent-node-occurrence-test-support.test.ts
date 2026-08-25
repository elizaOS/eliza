/**
 * Exercises the test-only Docker-node occurrence trigger installer against the
 * live 0301 migration: selected statements, order, sequential apply, and the
 * fail-closed missing-or-reordered SQL path.
 */

import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { installAgentNodeOccurrenceTriggerForTests } from "./agent-node-occurrence-test-support";

const FUNCTION_MARKER = 'CREATE OR REPLACE FUNCTION "journal_agent_node_incarnation"()';
const TRIGGER_MARKER = 'CREATE TRIGGER "docker_nodes_incarnation_history"';
const MISSING_OR_REORDERED =
  "node occurrence migration trigger statements are missing or reordered";

const FUNCTION_SQL = `${FUNCTION_MARKER}
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;`;
const TRIGGER_SQL = `${TRIGGER_MARKER}
  BEFORE INSERT ON "docker_nodes"
  FOR EACH ROW EXECUTE FUNCTION "journal_agent_node_incarnation"();`;

const originalReadFileSync = fs.readFileSync;

function readMigrationOverride(text: string): ReturnType<typeof spyOn> {
  return spyOn(fs, "readFileSync").mockImplementation(((
    path: Parameters<typeof originalReadFileSync>[0],
    options?: Parameters<typeof originalReadFileSync>[1],
  ) => {
    if (String(path).includes("0301_agent_node_occurrence_trigger.sql")) {
      return text;
    }
    return originalReadFileSync(path, options as BufferEncoding);
  }) as typeof originalReadFileSync);
}

async function collectInstalled(): Promise<string[]> {
  const executed: string[] = [];
  await installAgentNodeOccurrenceTriggerForTests(async (statement) => {
    executed.push(statement);
  });
  return executed;
}

describe("installAgentNodeOccurrenceTriggerForTests", () => {
  test("installs the live function then the live trigger and skips lock and drop statements", async () => {
    const executed = await collectInstalled();

    expect(executed).toHaveLength(2);
    expect(executed[0]).toContain(FUNCTION_MARKER);
    expect(executed[0]).toContain("RETURNS trigger LANGUAGE plpgsql");
    expect(executed[0]).toContain('NEW."current_node_history_id"');
    expect(executed[1]).toContain(TRIGGER_MARKER);
    expect(executed[1]).toContain("BEFORE INSERT OR UPDATE OF");
    expect(executed[1]).toContain('"current_node_history_id"');
    expect(executed[1]).toContain('EXECUTE FUNCTION "journal_agent_node_incarnation"()');

    expect(executed.some((statement) => statement.includes("LOCK TABLE"))).toBe(false);
    expect(executed.some((statement) => statement.includes("DROP TRIGGER"))).toBe(false);
    expect(executed.some((statement) => statement.includes("DROP FUNCTION"))).toBe(false);
    expect(executed[0]?.startsWith(FUNCTION_MARKER)).toBe(true);
    expect(executed[1]?.startsWith(TRIGGER_MARKER)).toBe(true);
  });

  test("awaits the function statement before executing the trigger", async () => {
    const order: string[] = [];
    let releaseFunction!: () => void;
    const functionGate = new Promise<void>((resolve) => {
      releaseFunction = resolve;
    });

    const running = installAgentNodeOccurrenceTriggerForTests(async (statement) => {
      if (statement.includes(FUNCTION_MARKER)) {
        order.push("function-start");
        await functionGate;
        order.push("function-end");
        return;
      }
      order.push("trigger");
    });

    await Promise.resolve();
    expect(order).toEqual(["function-start"]);
    releaseFunction();
    await running;
    expect(order).toEqual(["function-start", "function-end", "trigger"]);
  });

  test("stops after the first executeStatement rejection", async () => {
    const executed: string[] = [];
    const failure = new Error("install failed");

    await expect(
      installAgentNodeOccurrenceTriggerForTests(async (statement) => {
        executed.push(statement);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain(FUNCTION_MARKER);
  });

  test("returns undefined and ignores executeStatement results", async () => {
    await expect(
      installAgentNodeOccurrenceTriggerForTests(async () => ({ applied: true })),
    ).resolves.toBeUndefined();
  });

  test("throws when the migration file is empty", async () => {
    const spy = readMigrationOverride("");
    try {
      await expect(collectInstalled()).rejects.toThrow(MISSING_OR_REORDERED);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws when the queue is empty after filtering lock and drop statements", async () => {
    const spy = readMigrationOverride(
      'LOCK TABLE "docker_nodes" IN ACCESS EXCLUSIVE MODE;\n--> statement-breakpoint\nDROP FUNCTION "block_agent_node_occurrence_cutover"();',
    );
    try {
      await expect(collectInstalled()).rejects.toThrow(MISSING_OR_REORDERED);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws when only the function statement is present", async () => {
    const spy = readMigrationOverride(FUNCTION_SQL);
    try {
      await expect(collectInstalled()).rejects.toThrow(MISSING_OR_REORDERED);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws when only the trigger statement is present", async () => {
    const spy = readMigrationOverride(TRIGGER_SQL);
    try {
      await expect(collectInstalled()).rejects.toThrow(MISSING_OR_REORDERED);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws when the trigger appears before the function", async () => {
    const spy = readMigrationOverride(`${TRIGGER_SQL}\n--> statement-breakpoint\n${FUNCTION_SQL}`);
    try {
      await expect(collectInstalled()).rejects.toThrow(MISSING_OR_REORDERED);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws when more than two matching statements survive the filter", async () => {
    const spy = readMigrationOverride(
      `${FUNCTION_SQL}\n--> statement-breakpoint\n${TRIGGER_SQL}\n--> statement-breakpoint\n${FUNCTION_SQL}`,
    );
    try {
      await expect(collectInstalled()).rejects.toThrow(MISSING_OR_REORDERED);
    } finally {
      spy.mockRestore();
    }
  });

  test("trims whitespace around a well-ordered function and trigger pair", async () => {
    const spy = readMigrationOverride(
      `  ${FUNCTION_SQL}  \n--> statement-breakpoint\n\n  ${TRIGGER_SQL}  \n`,
    );
    try {
      const executed = await collectInstalled();
      expect(executed).toHaveLength(2);
      expect(executed[0]).toBe(FUNCTION_SQL);
      expect(executed[1]).toBe(TRIGGER_SQL);
    } finally {
      spy.mockRestore();
    }
  });
});
