/** Exercises the public fixture entry in a real Node process with isolated native SQLite databases. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads fixtures through the package root and keeps temporary databases isolated", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        import { createSQLiteTestRuntime } from "@elizaos/testing";

        const agentId = "00000000-0000-4000-8000-000000000001";
        const entityId = "00000000-0000-4000-8000-000000000002";
        const options = {
          agentId,
          character: { name: "package fixture", bio: [] },
          plugins: [],
        };
        const first = createSQLiteTestRuntime(options);
        const second = createSQLiteTestRuntime(options);
        await Promise.all([first.adapter.initialize(), second.adapter.initialize()]);
        try {
          const entity = { id: entityId, agentId, names: ["persisted fixture"], metadata: {} };
          await first.adapter.createEntities([entity]);
          assert.deepEqual(await first.adapter.getEntitiesByIds([entityId]), [entity]);
          assert.deepEqual(await second.adapter.getEntitiesByIds([entityId]), []);
        } finally {
          await Promise.all([first.adapter.close(), second.adapter.close()]);
        }
      `,
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
