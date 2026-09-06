/** Exercises the checked-in Telegram column upgrade against existing app state in isolated PGlite. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("Telegram migration permits restore's absent config while preserving configured apps and defaults", async () => {
  const database = new PGlite();
  try {
    await database.exec("CREATE TABLE apps (id integer PRIMARY KEY, name text NOT NULL)");
    await database.exec(
      await readFile(
        new URL("./0010_add_telegram_automation_to_apps.sql", import.meta.url),
        "utf8",
      ),
    );
    await database.exec("INSERT INTO apps (id, name) VALUES (1, 'configured'), (2, 'restore')");
    const configured = { enabled: true, channelId: "fixture-channel", autoReply: false };
    await database.query("UPDATE apps SET telegram_automation = $1::jsonb WHERE id = 1", [
      JSON.stringify(configured),
    ]);
    const defaultBefore = (
      await database.query("SELECT telegram_automation FROM apps WHERE id = 2")
    ).rows;
    await expect(
      database.exec("UPDATE apps SET telegram_automation = NULL WHERE id = 2"),
    ).rejects.toMatchObject({ code: "23502" });

    const migration = await readFile(
      new URL("./0365_apps_telegram_automation_nullable.sql", import.meta.url),
      "utf8",
    );
    await database.exec(migration);
    await database.exec("UPDATE apps SET telegram_automation = NULL WHERE id = 2");
    await database.exec(migration);
    expect(
      (await database.query("SELECT id, name, telegram_automation FROM apps ORDER BY id")).rows,
    ).toEqual([
      { id: 1, name: "configured", telegram_automation: configured },
      { id: 2, name: "restore", telegram_automation: null },
    ]);
    await database.exec("INSERT INTO apps (id, name) VALUES (3, 'fresh')");
    expect(
      (await database.query("SELECT telegram_automation FROM apps WHERE id = 3")).rows,
    ).toEqual(defaultBefore);
  } finally {
    await database.close();
  }
}, 60_000);
