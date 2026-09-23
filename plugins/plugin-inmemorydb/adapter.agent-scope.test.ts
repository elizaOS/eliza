/** Verifies lifecycle scopes keep cache ownership separate on the real ephemeral adapter. */
import { randomUUID } from "node:crypto";
import type { UUID } from "@elizaos/core";
import { expect, test } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

test("target cache writes cannot change the importing agent's cache", async () => {
  const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), randomUUID() as UUID);
  await adapter.init();
  try {
    const target = randomUUID() as UUID;
    await adapter.setCaches([{ key: "scope-proof", value: "host" }]);
    await adapter.withAgentScope(target, (scoped) =>
      scoped.setCaches([{ key: "scope-proof", value: "target" }])
    );
    expect((await adapter.getCaches(["scope-proof"])).get("scope-proof")).toBe("host");
    expect(
      (await adapter.withAgentScope(target, (scoped) => scoped.getCaches(["scope-proof"]))).get(
        "scope-proof"
      )
    ).toBe("target");
  } finally {
    await adapter.close();
  }
});
