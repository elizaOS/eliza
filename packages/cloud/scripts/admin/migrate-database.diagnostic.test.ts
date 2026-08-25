import { describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

mock.module("./local-dev-helpers", () => ({
  loadEnvFiles: mock(),
}));

const {
  DESTINATION_MIGRATION_SCRIPT,
  databaseMigrationFatalDiagnostic,
  withDatabaseMigrationStage,
} = await import("./migrate-database");

const scriptPath = path.join(import.meta.dir, "migrate-database.ts");
const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const migrationsDirectory = path.join(
  repositoryRoot,
  "packages/cloud/shared/src/db/migrations",
);
const journalPath = path.join(migrationsDirectory, "meta/_journal.json");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function runAdminScript(args: string[], environment: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["--conditions=eliza-source", scriptPath, ...args],
    {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
}

async function seedLegacyPhoneJsonFailure(
  dataDirectory: string,
  malformedJson: string,
): Promise<void> {
  const database = await PGlite.create({
    dataDir: dataDirectory,
    extensions: { vector },
  });
  try {
    await database.exec(`
      CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE agent_phone_numbers (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        metadata text DEFAULT '{}'
      );
      CREATE TABLE phone_message_log (
        phone_number_id uuid REFERENCES agent_phone_numbers(id) ON DELETE CASCADE,
        media_urls text,
        media_urls_storage text NOT NULL DEFAULT 'inline',
        media_urls_key text,
        metadata text DEFAULT '{}',
        metadata_storage text NOT NULL DEFAULT 'inline',
        metadata_key text
      );
      CREATE TABLE agent_phone_contacts (metadata text DEFAULT '{}' NOT NULL);
      CREATE TABLE phone_gateway_devices (metadata text DEFAULT '{}' NOT NULL);
      INSERT INTO organizations (id)
      VALUES ('71111111-1111-4111-8111-111111111111');
    `);
    await database.query(
      `INSERT INTO agent_phone_numbers (id, organization_id, metadata)
       VALUES ('72222222-2222-4222-8222-222222222222',
         '71111111-1111-4111-8111-111111111111', $1)`,
      [malformedJson],
    );

    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: JournalEntry[];
    };
    const checkpointIndex = journal.entries.findIndex(
      ({ tag }) => tag === "0194_job_execution_interruptions_catalog_guard",
    );
    const phoneMigrationIndex = journal.entries.findIndex(
      ({ tag }) => tag === "0295_phone_message_payload_jsonb",
    );
    if (checkpointIndex === -1 || phoneMigrationIndex === -1) {
      throw new Error("Required migration journal entries are missing");
    }

    for (const entry of journal.entries.slice(
      checkpointIndex,
      phoneMigrationIndex,
    )) {
      const source = await readFile(
        path.join(migrationsDirectory, `${entry.tag}.sql`),
        "utf8",
      );
      const hash = createHash("sha256").update(source).digest("hex");
      await database.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [hash, entry.when],
      );
    }
  } finally {
    await database.close();
  }
}

describe("migrate-database fatal diagnostics", () => {
  test("resolves the real destination migration runner independent of cwd", async () => {
    expect(path.isAbsolute(DESTINATION_MIGRATION_SCRIPT)).toBe(true);
    expect(path.basename(DESTINATION_MIGRATION_SCRIPT)).toBe(
      "migrate-with-diagnostics.ts",
    );
    expect(await Bun.file(DESTINATION_MIGRATION_SCRIPT).exists()).toBe(true);
  });

  test("classifies the real CLI argument stage without logging rejected input", () => {
    const secretArgument = "--diagnostic-secret-must-not-leak";
    const result = runAdminScript([secretArgument], process.env);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('code: "DATABASE_MIGRATION_ARGUMENT_INVALID"');
    expect(output).toContain('stage: "arguments"');
    expect(output).not.toContain(secretArgument);
    expect(output).not.toContain("Unknown argument");
  });

  test("classifies the real CLI configuration stage", () => {
    const result = runAdminScript([], {
      ...process.env,
      DATABASE_URL: "",
      NEW_DATABASE_URL: "",
      NEW_POSTGRES_URL: "",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain(
      'code: "DATABASE_MIGRATION_CONFIGURATION_INVALID"',
    );
    expect(output).toContain('stage: "configuration"');
    expect(output).not.toContain("DATABASE_URL (source) is required");
    expect(output).not.toContain("cause");
  });

  test("redacts a malformed legacy JSON token through the real 0295 child failure path", async () => {
    const privateToken = "PHONE_JSON_PRIVATE_SENTINEL_7f43cbb2";
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "eliza-phone-jsonb-diagnostic-"),
    );

    try {
      await seedLegacyPhoneJsonFailure(
        dataDirectory,
        `{"private":${privateToken}}`,
      );
      const destinationUrl = `pglite://${dataDirectory}`;
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_IDENTITY_GATE_MODE: "off",
        DATABASE_URL: "postgresql://source:source@127.0.0.1:1/source",
        NEW_DATABASE_URL: destinationUrl,
        NEW_POSTGRES_URL: destinationUrl,
      };
      delete environment.DATABASE_IDENTITY_ENVIRONMENT;

      const result = runAdminScript([], environment);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(1);
      expect(output).toContain("0295_phone_message_payload_jsonb");
      expect(output).toContain("code=DATABASE_OPERATION_FAILED");
      expect(output).toContain("database_code=22P02");
      expect(output).toContain('code: "DATABASE_MIGRATION_SCHEMA_FAILED"');
      expect(output).toContain('stage: "destination_schema"');
      expect(output).not.toContain(privateToken);
      expect(output).not.toContain("detail=");
      expect(output).not.toContain('Token "PHONE_JSON_PRIVATE');

      const verificationDatabase = await PGlite.create({
        dataDir: dataDirectory,
        extensions: { vector },
      });
      try {
        const column = await verificationDatabase.query<{
          data_type: string;
        }>(`
            SELECT data_type
            FROM information_schema.columns
            WHERE table_name = 'agent_phone_numbers'
              AND column_name = 'metadata'
          `);
        expect(column.rows[0]?.data_type).toBe("text");
      } finally {
        await verificationDatabase.close();
      }
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  test("keeps a bounded pointer classification through the table-copy stage", async () => {
    const secretMessage = "provider payload secret must not leak";
    const failure: unknown = await withDatabaseMigrationStage(
      "table_copy",
      () => {
        throw Object.assign(new Error(secretMessage), {
          code: "PHONE_MIGRATION_POINTER_INVALID",
        });
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "DATABASE_MIGRATION_STAGE_FAILED",
      context: { stage: "table_copy" },
      severity: "fatal",
    });
    const diagnostic = databaseMigrationFatalDiagnostic(failure);
    expect(diagnostic).toEqual({
      code: "DATABASE_MIGRATION_POINTER_INVALID",
      stage: "table_copy",
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secretMessage);
    expect(Object.keys(diagnostic).sort()).toEqual(["code", "stage"]);
  });
});
