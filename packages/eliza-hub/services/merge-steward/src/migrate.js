import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const DEFAULT_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "migrations",
);

export async function migrate({
  connectionString = process.env.DATABASE_URL ||
    process.env.MERGE_STEWARD_DATABASE_URL,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  pool,
  logger = console,
} = {}) {
  if (!pool && !connectionString) {
    throw new TypeError(
      "migrate requires DATABASE_URL or MERGE_STEWARD_DATABASE_URL",
    );
  }

  const ownedPool = pool ?? new Pool({ connectionString });
  const client = await ownedPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS steward_schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .sort();
    const applied = [];
    const skipped = [];

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = sha256(sql);
      const existing = await client.query(
        "SELECT checksum FROM steward_schema_migrations WHERE version = $1",
        [file],
      );

      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum mismatch for ${file}`);
        }
        skipped.push(file);
        continue;
      }

      await client.query(sql);
      await client.query(
        "INSERT INTO steward_schema_migrations (version, checksum) VALUES ($1, $2)",
        [file, checksum],
      );
      applied.push(file);
      logger.info?.("[MergeStewardMigrate] applied", { migration: file });
    }

    return { applied, skipped };
  } finally {
    client.release?.();
    if (!pool) {
      await ownedPool.end();
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then((result) => {
      console.info("[MergeStewardMigrate] complete", result);
    })
    .catch((error) => {
      // error-policy:J1 CLI process boundary: log and exit non-zero
      console.error("[MergeStewardMigrate] failed", error);
      process.exitCode = 1;
    });
}
