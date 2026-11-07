import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { loadCanonicalMigrations } from "./canonical-migration-ledger";
import { probeFunding0387 } from "./probe-agent-compute-funding-0387";

const migrations = await loadCanonicalMigrations();
const migration = migrations.find(
  (m) => m.entry.tag === "0387_agent_compute_funding",
);
if (!migration) throw new Error("Missing canonical migration fixture");
const historical = await readFile(
  new URL(
    "./fixtures/0387-agent-compute-funding-historical.sql",
    import.meta.url,
  ),
  "utf8",
);
const canonical = await readFile(
  new URL(
    "../../shared/src/db/migrations/0387_agent_compute_funding.sql",
    import.meta.url,
  ),
  "utf8",
);
const hashes = {
  historical: createHash("sha256").update(historical).digest("hex"),
  canonical: createHash("sha256").update(canonical).digest("hex"),
};
async function database(sql: string, hash: string) {
  const db = new PGlite("memory://");
  await db.exec(`CREATE TABLE agent_sandboxes(id uuid,organization_id uuid, UNIQUE(id,organization_id));
    CREATE TABLE billing_funding_reservations(id uuid,organization_id uuid, UNIQUE(id,organization_id));
    CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text,created_at bigint);`);
  await db.exec(sql);
  await db.query(
    "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)",
    [hash, migration?.entry.when],
  );
  return db;
}
function allTrue(row: Record<string, boolean>) {
  return Object.values(row).every(Boolean);
}

test("actual historical and canonical SQL produce their exact catalog match flags in read-only transactions", async () => {
  for (const [variant, sql] of [
    ["historical", historical],
    ["canonical", canonical],
  ] as const) {
    const db = await database(sql, hashes[variant]);
    try {
      await db.exec("BEGIN READ ONLY");
      const report = await probeFunding0387(db, migrations);
      expect(report.variant).toBe(variant);
      expect(report.reason).toBeNull();
      expect(report.relation).toEqual({ present: true, kind: "table" });
      const match = report.schemaMatches?.[variant];
      expect(match).toBeDefined();
      expect(allTrue(match?.columns ?? {})).toBe(true);
      expect(allTrue(match?.constraints ?? {})).toBe(true);
      expect(allTrue(match?.indexes ?? {})).toBe(true);
      expect(match?.noUnexpectedColumns).toBe(true);
      expect(match?.noUnexpectedConstraints).toBe(true);
      expect(match?.noUnexpectedIndexes).toBe(true);
      expect(report.schemaMatches?.canonical.columns.previous_funding_id).toBe(
        variant === "canonical",
      );
      expect(
        report.schemaMatches?.canonical.columns.host_lease_confirmed_at,
      ).toBe(variant === "canonical");
      expect(JSON.stringify(report)).not.toContain(hashes[variant]);
      await db.exec("COMMIT");
    } finally {
      await db.close();
    }
  }
});

test("duplicate rows and changed source refuse catalog observation", async () => {
  const db = await database(historical, "PRIVATE_UNKNOWN_HASH");
  try {
    await db.query("UPDATE drizzle.__drizzle_migrations SET hash=$1", [
      hashes.historical,
    ]);
    await db.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)",
      [hashes.historical, migration?.entry.when],
    );
    expect(await probeFunding0387(db, migrations)).toEqual({
      variant: "unknown",
      reason: "ledger_row_count",
      schemaMatches: null,
    });
    const changed = migrations.map((m) =>
      m === migration ? { ...m, hash: "changed" } : m,
    );
    expect(await probeFunding0387(db, changed)).toEqual({
      variant: "unknown",
      reason: "source_guard",
      schemaMatches: null,
    });
  } finally {
    await db.close();
  }
});

test("schema drift reports booleans without stored defaults or unexpected names", async () => {
  const db = await database(canonical, "PRIVATE_UNKNOWN_HASH");
  try {
    await db.exec(`ALTER TABLE agent_compute_funding ALTER COLUMN provider_node_id SET DEFAULT 'PRIVATE_DEFAULT';
      ALTER TABLE agent_compute_funding ADD COLUMN "PRIVATE_COLUMN" text;
      ALTER TABLE agent_compute_funding DROP CONSTRAINT agent_compute_funding_host_confirmation_check;
      DROP INDEX agent_compute_funding_predecessor_idx;`);
    await db.exec("BEGIN READ ONLY");
    const report = await probeFunding0387(db, migrations);
    expect(report.schemaMatches?.canonical.columns.provider_node_id).toBe(
      false,
    );
    expect(report.schemaMatches?.canonical.noUnexpectedColumns).toBe(false);
    expect(
      report.schemaMatches?.canonical.constraints
        .agent_compute_funding_host_confirmation_check,
    ).toBe(false);
    expect(
      report.schemaMatches?.canonical.indexes
        .agent_compute_funding_predecessor_idx,
    ).toBe(false);
    const text = JSON.stringify(report);
    for (const privateText of [
      "PRIVATE_DEFAULT",
      "PRIVATE_COLUMN",
      hashes.canonical,
      "PRIVATE_UNKNOWN_HASH",
    ])
      expect(text).not.toContain(privateText);
    await db.exec("COMMIT");
  } finally {
    await db.close();
  }
});

test("query errors never expose messages, parameters or database values", async () => {
  const report = await probeFunding0387(
    {
      async query() {
        throw Error("postgres://PRIVATE_CREDENTIAL@PRIVATE_HOST/db");
      },
    },
    migrations,
  );
  expect(report).toEqual({
    variant: "unavailable",
    reason: null,
    schemaMatches: null,
  });
});

test("changed historical fixture returns a fixed reason before any database read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "funding-probe-fixture-"));
  try {
    await mkdir(join(directory, "fixtures"));
    const modulePath = join(directory, "probe.ts");
    await copyFile(
      new URL("./probe-agent-compute-funding-0387.ts", import.meta.url),
      modulePath,
    );
    for (const filename of [
      "ledger-association-diagnostic.ts",
      "canonical-migration-ledger.ts",
    ]) {
      await copyFile(
        new URL(`./${filename}`, import.meta.url),
        join(directory, filename),
      );
    }
    await writeFile(
      join(directory, "fixtures/0387-agent-compute-funding-historical.sql"),
      "PRIVATE_CHANGED_FIXTURE",
    );
    const isolated = await import(pathToFileURL(modulePath).href);
    let reads = 0;
    const report = await isolated.probeFunding0387(
      {
        query: async () => {
          reads++;
          throw Error("PRIVATE_DB_ERROR");
        },
      },
      migrations,
    );
    expect(report).toEqual({
      variant: "unknown",
      reason: "fixture_guard",
      schemaMatches: null,
    });
    expect(reads).toBe(0);
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown hashes expose only diagnostic catalog flags for actual old and new schemas", async () => {
  for (const [variant, sql] of [
    ["historical", historical],
    ["canonical", canonical],
  ] as const) {
    const db = await database(sql, "PRIVATE_UNKNOWN_HASH");
    try {
      await db.exec("BEGIN READ ONLY");
      const report = await probeFunding0387(db, migrations);
      expect(report.variant).toBe("unknown");
      expect(report.reason).toBe("unknown_hash");
      expect(report.schemaPurpose).toBe("diagnostic_only");
      const match = report.schemaMatches?.[variant];
      expect(match).toBeDefined();
      expect(allTrue(match?.columns ?? {})).toBe(true);
      expect(allTrue(match?.constraints ?? {})).toBe(true);
      expect(allTrue(match?.indexes ?? {})).toBe(true);
      expect(JSON.stringify(report)).not.toContain("PRIVATE_UNKNOWN_HASH");
      await db.exec("COMMIT");
    } finally {
      await db.close();
    }
  }
});

test("absent funding relation and private canonical hash associations remain diagnostic", async () => {
  const other = migrations.find(
    (item) =>
      item.entry.tag !== migration?.entry.tag &&
      migrations.filter((candidate) => candidate.hash === item.hash).length ===
        1,
  );
  if (!other) throw new Error("Missing unique migration fixture");
  const db = await database(historical, other.hash);
  try {
    await db.exec("DROP TABLE agent_compute_funding; BEGIN READ ONLY");
    const report = await probeFunding0387(db, migrations);
    expect(report.relation).toEqual({ present: false, kind: "absent" });
    expect(report.hashAssociation).toEqual({
      status: "unique",
      canonicalTag: other.entry.tag,
    });
    expect(report.variant).toBe("unknown");
    expect(report.reason).toBe("unknown_hash");
    expect(report.schemaPurpose).toBe("diagnostic_only");
    expect(
      Object.values(report.schemaMatches?.canonical.columns ?? {}).every(
        (value) => value === false,
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(other.hash);
    const ambiguous = await probeFunding0387(db, [
      ...migrations,
      {
        ...other,
        entry: { ...other.entry, tag: "reviewed_duplicate_fixture" },
      },
    ]);
    expect(ambiguous.hashAssociation).toEqual({
      status: "ambiguous",
      canonicalTag: null,
    });
    expect(JSON.stringify(ambiguous)).not.toContain(other.hash);
    await db.exec("COMMIT");
    await db.query("UPDATE drizzle.__drizzle_migrations SET hash=$1", [
      "PRIVATE_UNKNOWN_HASH",
    ]);
    await db.exec("BEGIN READ ONLY");
    const unknown = await probeFunding0387(db, migrations);
    expect(unknown.hashAssociation).toEqual({
      status: "none",
      canonicalTag: null,
    });
    expect(JSON.stringify(unknown)).not.toContain("PRIVATE_UNKNOWN_HASH");
    await db.exec("COMMIT");
  } finally {
    await db.close();
  }
});
