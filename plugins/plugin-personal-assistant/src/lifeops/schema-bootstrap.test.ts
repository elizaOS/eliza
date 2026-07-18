/** Verifies LifeOps schema bootstrap readiness, concurrency, and retry semantics. */

import { AgentRuntime, InMemoryDatabaseAdapter } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsRepository } from "./repository.js";
import { ensureLifeOpsSchema } from "./schema-bootstrap.js";

function makeRuntime(): {
  adapter: InMemoryDatabaseAdapter;
  runtime: AgentRuntime;
} {
  const adapter = new InMemoryDatabaseAdapter();
  const runtime = new AgentRuntime({
    adapter,
    character: { name: "lifeops-schema-bootstrap-test" },
    disableBasicCapabilities: true,
    logLevel: "fatal",
  });
  return { adapter, runtime };
}

describe("ensureLifeOpsSchema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not cache a no-op before the adapter is ready", async () => {
    const { adapter, runtime } = makeRuntime();
    const bootstrap = vi
      .spyOn(LifeOpsRepository, "bootstrapSchema")
      .mockResolvedValue();

    await ensureLifeOpsSchema(runtime);
    expect(bootstrap).not.toHaveBeenCalled();

    await adapter.init();
    await ensureLifeOpsSchema(runtime);
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("shares one migration across concurrent callers", async () => {
    const { adapter, runtime } = makeRuntime();
    await adapter.init();
    let resolveBootstrap: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });
    const bootstrap = vi
      .spyOn(LifeOpsRepository, "bootstrapSchema")
      .mockReturnValue(pending);

    const callers = Promise.all([
      ensureLifeOpsSchema(runtime),
      ensureLifeOpsSchema(runtime),
    ]);
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
    if (!resolveBootstrap) {
      throw new Error("Expected the schema bootstrap promise to be pending");
    }
    resolveBootstrap();
    await callers;
  });

  it("evicts a rejected migration so the next caller retries", async () => {
    const { adapter, runtime } = makeRuntime();
    await adapter.init();
    const failure = new Error("migration failed");
    const bootstrap = vi
      .spyOn(LifeOpsRepository, "bootstrapSchema")
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();

    await expect(ensureLifeOpsSchema(runtime)).rejects.toBe(failure);
    await expect(ensureLifeOpsSchema(runtime)).resolves.toBeUndefined();
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });
});
