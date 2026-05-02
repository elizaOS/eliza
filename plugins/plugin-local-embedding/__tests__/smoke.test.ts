import { describe, expect, it } from "vitest";

describe("@elizaos/plugin-local-embedding", () => {
  it(
    "exports the plugin",
    async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();
    },
    60_000,
  );
});
