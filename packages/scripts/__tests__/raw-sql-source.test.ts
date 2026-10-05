import { expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
    cpSync(join(repoRoot, "plugins/plugin-sql/src"), join(shared, "src"), {
      recursive: true,
    });
    for (const file of ["package.json"]) {
      copyFileSync(
        join(repoRoot, "plugins/plugin-sql", file),
        join(shared, file),
      );
    }
    const manifest = JSON.parse(
      readFileSync(join(shared, "package.json"), "utf8"),
    );
    for (const name of Object.keys(manifest.dependencies)) {
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
      import { executeSql, sqlQuote } from "@elizaos/plugin-sql";
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
