import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plugin } from "../../../index";

describe("PostgreSQL Initialization Tests", () => {
  let agentRuntime: IAgentRuntime;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.POSTGRES_URL;
    delete process.env.PGLITE_DATA_DIR;

    agentRuntime = {
      agentId: "00000000-0000-0000-0000-000000000000",
      getSetting: vi.fn(),
      registerDatabaseAdapter: vi.fn(),
      registerService: vi.fn(),
      getService: vi.fn(),
      hasElizaOS: vi.fn(() => false),
      logger: {
        info: vi.fn(() => {}),
        debug: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
      },
    } as Partial<IAgentRuntime> & {
      getSetting: ReturnType<typeof vi.fn>;
      registerDatabaseAdapter: ReturnType<typeof vi.fn>;
      databaseAdapter?: unknown;
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    // Mocks auto-clear in vitest;
  });

  it("should initialize with PostgreSQL when POSTGRES_URL is provided", async () => {
    const postgresUrl = "postgresql://test:test@localhost:5432/testdb";
    vi.mocked(agentRuntime.getSetting).mockImplementation((key: string) => {
      if (key === "POSTGRES_URL") return postgresUrl;
      return undefined;
    });

    await plugin.init?.({}, agentRuntime);

    expect(agentRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    const adapter = vi.mocked(agentRuntime.registerDatabaseAdapter).mock.calls[0][0];
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe("PgDatabaseAdapter");
  });

  it("should skip initialization if database adapter already exists", async () => {
    // Simulate existing adapter
    (agentRuntime as Partial<IAgentRuntime> & { databaseAdapter?: unknown }).databaseAdapter = {
      test: true,
    };

    await plugin.init?.({}, agentRuntime);

    expect(agentRuntime.registerDatabaseAdapter).not.toHaveBeenCalled();
  });

  it("should use PGLITE_DATA_DIR when provided", async () => {
    // Use a proper temporary directory that actually exists
    const pglitePath = join(tmpdir(), `eliza-test-pglite-${Date.now()}`);
    vi.mocked(agentRuntime.getSetting).mockImplementation((key: string) => {
      if (key === "PGLITE_DATA_DIR") return pglitePath;
      return undefined;
    });

    await plugin.init?.({}, agentRuntime);

    expect(agentRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    const adapter = vi.mocked(agentRuntime.registerDatabaseAdapter).mock.calls[0][0];
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe("PgliteDatabaseAdapter");
  });

  it("should use default path when PGLITE_DATA_DIR is not provided", async () => {
    (agentRuntime.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await plugin.init?.({}, agentRuntime);

    expect(agentRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    const adapter = vi.mocked(agentRuntime.registerDatabaseAdapter).mock.calls[0][0];
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe("PgliteDatabaseAdapter");
  });

  it("should use default path when no configuration is provided", async () => {
    (agentRuntime.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await plugin.init?.({}, agentRuntime);

    expect(agentRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    const adapter = vi.mocked(agentRuntime.registerDatabaseAdapter).mock.calls[0][0];
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe("PgliteDatabaseAdapter");
  });

  it("should handle errors gracefully during adapter check", async () => {
    // Make databaseAdapter throw an error when accessed
    Object.defineProperty(agentRuntime, "databaseAdapter", {
      get() {
        throw new Error("No adapter");
      },
      configurable: true,
    });

    (agentRuntime.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await plugin.init?.({}, agentRuntime);

    expect(agentRuntime.registerDatabaseAdapter).toHaveBeenCalled();
  });
});
