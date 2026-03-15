import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseAdapter, plugin } from "../../../index";

describe("PostgreSQL / PGlite adapter factory", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.POSTGRES_URL;
    delete process.env.PGLITE_DATA_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("plugin exposes adapter factory (no init)", () => {
    expect(plugin.adapter).toBeDefined();
    expect(typeof plugin.adapter).toBe("function");
    expect(plugin.init).toBeUndefined();
  });

  it("adapter factory returns PgDatabaseAdapter when POSTGRES_URL is in settings", () => {
    const agentId = "00000000-0000-0000-0000-000000000000";
    const settings = { POSTGRES_URL: "postgresql://test:test@localhost:5432/testdb" };
    const adapter = plugin.adapter!(agentId, settings);
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe("PgDatabaseAdapter");
  });

  it("adapter factory returns PgliteDatabaseAdapter when only PGLITE_DATA_DIR", () => {
    const agentId = "00000000-0000-0000-0000-000000000000";
    const pglitePath = join(tmpdir(), `eliza-test-pglite-${Date.now()}`);
    const settings = { PGLITE_DATA_DIR: pglitePath };
    const adapter = plugin.adapter!(agentId, settings);
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe("PgliteDatabaseAdapter");
  });

  it("adapter factory returns PgliteDatabaseAdapter when no URL", () => {
    const agentId = "00000000-0000-0000-0000-000000000000";
    const adapter = plugin.adapter!(agentId, {});
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe("PgliteDatabaseAdapter");
  });

  it("createDatabaseAdapter with postgresUrl returns PgDatabaseAdapter", () => {
    const agentId = "00000000-0000-0000-0000-000000000000";
    const adapter = createDatabaseAdapter(
      { postgresUrl: "postgresql://test:test@localhost:5432/testdb" },
      agentId
    );
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe("PgDatabaseAdapter");
  });

  it("createDatabaseAdapter without postgresUrl returns PgliteDatabaseAdapter", () => {
    const agentId = "00000000-0000-0000-0000-000000000000";
    const pglitePath = join(tmpdir(), `eliza-test-pglite-${Date.now()}`);
    const adapter = createDatabaseAdapter({ dataDir: pglitePath }, agentId);
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe("PgliteDatabaseAdapter");
  });
});
