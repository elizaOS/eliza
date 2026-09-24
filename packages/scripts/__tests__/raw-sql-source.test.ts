import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

test("migration SQL executes from a clean source-only SQL plugin", async () => {
  const root = mkdtempSync(join(tmpdir(), "eliza-raw-sql-source-"));
  try {
    const shared = join(root, "node_modules/@elizaos/plugin-sql");
    mkdirSync(join(shared, "src/database-utils"), { recursive: true });
    for (const file of ["package.json", "src/database-utils/raw-sql.ts"]) {
      copyFileSync(
        join(repoRoot, "plugins/plugin-sql", file),
        join(shared, file),
      );
    }
    for (const name of ["drizzle-orm", "@electric-sql/pglite"]) {
      const target = join(root, "node_modules", name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(
        dirname(
          Bun.resolveSync(
            `${name}/package.json`,
            join(repoRoot, "plugins/plugin-sql"),
          ),
        ),
        target,
        "junction",
      );
    }
    writeFileSync(
      join(root, "consumer.ts"),
      `
      import { PGlite } from "@electric-sql/pglite";
      import { drizzle } from "drizzle-orm/pglite";
      import { executeSql, sqlQuote } from "@elizaos/plugin-sql/database-utils/raw-sql";
      const postgres = new PGlite();
      try {
        const db = drizzle(postgres);
        await executeSql(db, "CREATE TABLE migration_probe (value text NOT NULL)");
        await executeSql(db, "INSERT INTO migration_probe VALUES (" + sqlQuote("O'Brien") + ")");
        console.log(JSON.stringify(await executeSql(db, "SELECT value FROM migration_probe")));
      } finally {
        await postgres.close();
      }
    `,
    );
    const child = Bun.spawn(
      [process.execPath, "--conditions=eliza-source", "consumer.ts"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{ value: "O'Brien" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
