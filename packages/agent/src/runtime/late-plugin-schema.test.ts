/**
 * Proves late plugin schemas materialize in an isolated PGlite database before the
 * runtime publishes the plugin or starts services that query those tables.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import {
  AgentRuntime,
  createCharacter,
  InMemoryDatabaseAdapter,
  type JsonValue,
  stringToUuid,
} from "@elizaos/core";
import { sql } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { INBOX_MIGRATION_SERVICE_TYPE } from "../../../../plugins/plugin-inbox/src/inbox/migration.ts";
import { inboxPlugin } from "../../../../plugins/plugin-inbox/src/plugin.ts";
import { RuntimeMigrator } from "../../../../plugins/plugin-sql/src/runtime-migrator/runtime-migrator.ts";
import * as sqlSchema from "../../../../plugins/plugin-sql/src/schema/index.ts";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle.ts";

const CONCURRENT_SCHEMA_PLUGIN = "concurrent-late-schema-plugin";
const concurrentSchema = pgSchema("app_concurrent_late");
const concurrentProbeTable = concurrentSchema.table("probe", {
  value: text("value").notNull(),
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) {
        throw new Error("Deferred promise was not initialized");
      }
      resolvePromise();
    },
  };
}

class PGliteMigrationAdapter extends InMemoryDatabaseAdapter {
  readonly pglite: PGlite;
  readonly pgliteDb: PgliteDatabase;
  readonly inboxMigrationEntered = deferred();
  readonly inboxMigrationRelease = deferred();
  activeMigrations = 0;
  maxConcurrentMigrations = 0;
  migrationBatches: string[][] = [];
  blockInboxMigration = false;

  constructor(dataDir: string) {
    super();
    this.pglite = new PGlite(dataDir, { extensions: { vector } });
    this.pgliteDb = drizzle(this.pglite);
    Object.defineProperty(this.db, "execute", {
      value: this.pgliteDb.execute.bind(this.pgliteDb),
    });
  }

  override async initialize(): Promise<void> {
    await this.pglite.waitReady;
    await super.initialize();
  }

  override async runPluginMigrations(
    plugins: Array<{
      name: string;
      schema?: Record<string, JsonValue | object>;
    }> = [],
    options?: {
      verbose?: boolean;
      force?: boolean;
      dryRun?: boolean;
    },
  ): Promise<void> {
    this.activeMigrations += 1;
    this.migrationBatches.push(plugins.map((plugin) => plugin.name));
    this.maxConcurrentMigrations = Math.max(
      this.maxConcurrentMigrations,
      this.activeMigrations,
    );
    try {
      if (
        this.blockInboxMigration &&
        plugins.some((plugin) => plugin.name === inboxPlugin.name)
      ) {
        this.inboxMigrationEntered.resolve();
        await this.inboxMigrationRelease.promise;
      }

      const migrator = new RuntimeMigrator(this.pgliteDb);
      for (const plugin of plugins) {
        if (plugin.schema) {
          await migrator.migrate(plugin.name, plugin.schema, options);
        }
      }
    } finally {
      this.activeMigrations -= 1;
    }
  }

  override async close(): Promise<void> {
    await super.close();
    await this.pglite.close();
  }
}

describe("late plugin schema ordering", () => {
  let runtime: AgentRuntime | null = null;
  let dataDir: string | null = null;

  async function createInitializedRuntime(): Promise<{
    runtime: AgentRuntime;
    adapter: PGliteMigrationAdapter;
  }> {
    dataDir = await mkdtemp(path.join(tmpdir(), "eliza-late-schema-"));
    const agentId = stringToUuid("late-schema-integration");
    const adapter = new PGliteMigrationAdapter(dataDir);
    await adapter.initialize();
    runtime = new AgentRuntime({
      character: createCharacter({
        id: agentId,
        name: "LateSchemaIntegration",
      }),
      adapter,
      logLevel: "fatal",
    });
    await runtime.registerPlugin({
      name: "@elizaos/plugin-sql",
      description: "Real SQL schema for the isolated PGlite runtime.",
      schema: sqlSchema,
    });
    await runtime.initialize();
    installRuntimePluginLifecycle(runtime);
    return { runtime, adapter };
  }

  afterEach(async () => {
    if (runtime) {
      for (const pluginName of [
        "@elizaos/plugin-inbox",
        CONCURRENT_SCHEMA_PLUGIN,
      ]) {
        if (runtime.plugins.some((plugin) => plugin.name === pluginName)) {
          await runtime.unloadPlugin(pluginName);
        }
      }
      await runtime.stop();
      await runtime.close();
      runtime = null;
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = null;
    }
  });

  it("materializes app_inbox before publishing the plugin or starting its migration service", async () => {
    const harness = await createInitializedRuntime();
    harness.adapter.blockInboxMigration = true;

    const registration = harness.runtime.registerPlugin(inboxPlugin);
    await harness.adapter.inboxMigrationEntered.promise;
    const publishedBeforeSchema = harness.runtime.plugins.some(
      (plugin) => plugin.name === inboxPlugin.name,
    );
    harness.adapter.inboxMigrationRelease.resolve();
    await registration;

    expect(publishedBeforeSchema).toBe(false);
    await harness.runtime.getServiceLoadPromise(INBOX_MIGRATION_SERVICE_TYPE);

    const tableRows = await harness.adapter.pgliteDb.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'app_inbox'
      ORDER BY table_name
    `);
    expect(tableRows.rows.map((row) => row.table_name)).toEqual([
      "life_email_unsubscribes",
      "life_inbox_triage_entries",
      "life_inbox_triage_examples",
    ]);
    expect(
      harness.runtime.getServiceRegistrationStatus(
        INBOX_MIGRATION_SERVICE_TYPE,
      ),
    ).toBe("registered");
  });

  it("serializes concurrent late schema migrations on one adapter", async () => {
    const harness = await createInitializedRuntime();
    harness.adapter.migrationBatches.length = 0;

    await Promise.all([
      harness.runtime.registerPlugin(inboxPlugin),
      harness.runtime.registerPlugin(inboxPlugin),
      harness.runtime.registerPlugin({
        name: CONCURRENT_SCHEMA_PLUGIN,
        description: "Concurrent migration ordering probe.",
        schema: { concurrentProbeTable },
      }),
    ]);
    await harness.runtime.getServiceLoadPromise(INBOX_MIGRATION_SERVICE_TYPE);

    const tableRows = await harness.adapter.pgliteDb.execute(sql`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE (table_schema = 'app_inbox' AND table_name = 'life_inbox_triage_entries')
         OR (table_schema = 'app_concurrent_late' AND table_name = 'probe')
      ORDER BY table_schema, table_name
    `);
    expect(tableRows.rows).toEqual([
      {
        table_schema: "app_concurrent_late",
        table_name: "probe",
      },
      {
        table_schema: "app_inbox",
        table_name: "life_inbox_triage_entries",
      },
    ]);
    expect(harness.adapter.maxConcurrentMigrations).toBe(1);
    expect(harness.adapter.migrationBatches).toEqual([
      ["@elizaos/plugin-inbox"],
      [CONCURRENT_SCHEMA_PLUGIN],
    ]);
    expect(
      harness.runtime.plugins.filter(
        (plugin) => plugin.name === "@elizaos/plugin-inbox",
      ),
    ).toHaveLength(1);
  });
});
