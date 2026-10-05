import { expect, it } from "bun:test";
import { createTestRuntimeWithModelProvider } from "../src/model-provider-runtime.ts";
import { createTestRuntime } from "../src/pglite-runtime.ts";

it("rejects invalid dimensions without changing process configuration", async () => {
  const before = { ...process.env };
  await expect(createTestRuntime({ embeddingDimensions: 0 })).rejects.toThrow(
    "positive integer",
  );
  expect(process.env).toEqual(before);
});

it("keeps overlapping databases isolated and cleanup idempotent", async () => {
  const before = Object.fromEntries(
    [
      "PGLITE_DATA_DIR",
      "EMBEDDING_DIMENSION",
      "LOCAL_EMBEDDING_DIMENSIONS",
    ].map((key) => [key, process.env[key]]),
  );
  const first = await createTestRuntime({
    characterName: "same-character",
    embeddingDimensions: 384,
  });
  let second: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
  try {
    second = await createTestRuntime({
      characterName: "same-character",
      embeddingDimensions: 384,
    });
    expect(first.pgliteDir).not.toBe(second.pgliteDir);
    await first.runtime.setCache("isolation", { value: "first" });
    expect(await second.runtime.getCache("isolation")).toBeUndefined();
    await first.cleanup();
    expect(first.cleanup()).toBe(first.cleanup());
    await second.runtime.setCache("isolation", { value: "second" });
    expect(await second.runtime.getCache("isolation")).toEqual({
      value: "second",
    });
  } finally {
    await Promise.all([first.cleanup(), second?.cleanup()]);
  }
  for (const [key, value] of Object.entries(before))
    expect(process.env[key]).toBe(value);
}, 180_000);

it.each([createTestRuntime, createTestRuntimeWithModelProvider])(
  "rolls back a failed host setup and removes its explicitly owned directory (%p)",
  async (create) => {
    const { mkdtempSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = mkdtempSync(join(tmpdir(), "fixture-setup-rollback-"));
    const error = new Error("host setup failed before plugin registration");
    await expect(
      create({
        pgliteDir: directory,
        removePgliteDirOnCleanup: true,
        configureRuntime: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(existsSync(directory)).toBe(false);
  },
);
