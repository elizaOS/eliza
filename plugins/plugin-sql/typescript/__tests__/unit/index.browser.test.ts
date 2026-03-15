import type { UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createDatabaseAdapter, plugin } from "../../index.browser";

describe("plugin-sql browser entrypoint", () => {
  const agentId = "00000000-0000-0000-0000-000000000000" as UUID;

  it("exposes adapter factory and no init", () => {
    expect(plugin.adapter).toBeDefined();
    expect(typeof plugin.adapter).toBe("function");
    expect(plugin.init).toBeUndefined();
  });

  it("adapter factory returns PGlite adapter", () => {
    const adapter = plugin.adapter!(agentId, {});
    expect(adapter).toBeDefined();
    expect(typeof adapter.init).toBe("function");
    expect(typeof adapter.isReady).toBe("function");
  });

  it("createDatabaseAdapter returns adapter", () => {
    const adapter = createDatabaseAdapter({}, agentId);
    expect(adapter).toBeDefined();
    expect(typeof adapter.init).toBe("function");
  });
});
