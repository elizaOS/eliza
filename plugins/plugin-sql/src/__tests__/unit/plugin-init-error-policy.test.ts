/**
 * Unit coverage for plugin-sql init error classification. These tests keep
 * unexpected runtime adapter-readiness failures from being misclassified as an
 * absent adapter and hidden behind a replacement registration.
 */
import type { IAgentRuntime, Plugin, UUID } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it, vi } from "vitest";
import { plugin as defaultPlugin } from "../../index";
import { plugin as browserPlugin } from "../../index.browser";
import { plugin as nodePlugin } from "../../index.node";

type RuntimeStub = IAgentRuntime & {
  getDatabaseAdapter?: () => never;
  registerDatabaseAdapter: ReturnType<typeof vi.fn>;
};

function createRuntimeStub(error: Error): RuntimeStub {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return {
    agentId: uuidv4() as UUID,
    getDatabaseAdapter: vi.fn(() => {
      throw error;
    }),
    getService: vi.fn(),
    getSetting: vi.fn(),
    isReady: vi.fn().mockRejectedValue(error),
    logger,
    registerDatabaseAdapter: vi.fn(),
  } as unknown as RuntimeStub;
}

async function expectInitReadinessError(plugin: Plugin, runtime: RuntimeStub): Promise<void> {
  if (!plugin.init) {
    throw new Error("plugin init is required for this test");
  }

  let thrown: unknown;
  try {
    await plugin.init({}, runtime);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ElizaError);
  expect(thrown).toMatchObject({ code: "DB_ADAPTER_READY_CHECK_FAILED" });
  expect((thrown as ElizaError).cause).toBeDefined();
  expect(runtime.registerDatabaseAdapter).not.toHaveBeenCalled();
}

describe("plugin-sql init error policy", () => {
  it("throws unexpected default entry adapter detection failures", async () => {
    const runtime = createRuntimeStub(new Error("adapter registry unavailable"));

    await expectInitReadinessError(defaultPlugin, runtime);
    expect(runtime.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: "adapter registry unavailable" }),
      "Database adapter detection failed"
    );
  });

  it("throws unexpected node entry adapter readiness failures", async () => {
    const runtime = createRuntimeStub(new Error("adapter health probe exploded"));

    await expectInitReadinessError(nodePlugin, runtime);
    expect(runtime.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: "adapter health probe exploded" }),
      "Database adapter readiness check failed"
    );
  });

  it("throws unexpected browser entry adapter readiness failures", async () => {
    const runtime = createRuntimeStub(new Error("browser adapter probe exploded"));

    await expectInitReadinessError(browserPlugin, runtime);
  });
});
