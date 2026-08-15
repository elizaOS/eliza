/** Upgrade-path proof for the Shared scheduled-task tenant primary key. */

import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

describe("0203 Shared scheduled-task tenant key", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it("upgrades the legacy global id key and permits the same id per agent", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(`
      CREATE SCHEMA app_scheduling;
      CREATE TABLE app_scheduling.life_scheduled_tasks (
        id text PRIMARY KEY NOT NULL,
        agent_id text NOT NULL,
        prompt_instructions text NOT NULL
      );
      INSERT INTO app_scheduling.life_scheduled_tasks
        (id, agent_id, prompt_instructions)
      VALUES ('shared-id', 'personal:a', 'a reminder');
    `);
    const migration = await readFile(
      new URL("./migrations/0203_shared_scheduled_task_tenant_key.sql", import.meta.url),
      "utf8",
    );

    await database.exec(migration);
    await database.exec(`
      INSERT INTO app_scheduling.life_scheduled_tasks
        (id, agent_id, prompt_instructions)
      VALUES ('shared-id', 'personal:b', 'b reminder');
    `);

    const rows = await database.query(
      `SELECT agent_id, prompt_instructions
         FROM app_scheduling.life_scheduled_tasks
        WHERE id = 'shared-id'
        ORDER BY agent_id`,
    );
    expect(rows.rows).toEqual([
      { agent_id: "personal:a", prompt_instructions: "a reminder" },
      { agent_id: "personal:b", prompt_instructions: "b reminder" },
    ]);
  });
});
