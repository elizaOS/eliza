/** Executes pg_trgm in real PGlite using the archive emitted by Android asset staging. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageAndroidPgliteAssets } from "./lib/stage-android-agent.mjs";

test("staged trigram archive loads and executes the SQL extension", async () => {
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const requireSql = createRequire(
    path.join(repo, "plugins/plugin-sql/package.json"),
  );
  const pgliteEntry = requireSql.resolve("@electric-sql/pglite");
  const { PGlite } = await import(pathToFileURL(pgliteEntry).href);
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "android-pglite-stage-"),
  );
  let db;
  try {
    const source = path.join(root, "dist-mobile");
    const main = path.join(root, "android/app/src/main");
    const staged = path.join(main, "assets/agent");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(staged, { recursive: true });
    await fs.copyFile(
      path.join(path.dirname(pgliteEntry), "pg_trgm.tar.gz"),
      path.join(source, "pg_trgm.tar.gz"),
    );
    stageAndroidPgliteAssets({
      distMobileDir: source,
      assetsAgentDir: staged,
      androidMainDir: main,
    });
    db = new PGlite({
      extensions: {
        pg_trgm: {
          name: "pg_trgm",
          setup: async () => ({
            bundlePath: pathToFileURL(path.join(staged, "pg_trgm.tar.gz")),
          }),
        },
      },
    });
    await db.exec("CREATE EXTENSION pg_trgm");
    const result = await db.query(
      "SELECT similarity('packaging', 'package') AS score",
    );
    assert.ok(result.rows[0].score > 0 && result.rows[0].score < 1);
  } finally {
    if (db) await db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
