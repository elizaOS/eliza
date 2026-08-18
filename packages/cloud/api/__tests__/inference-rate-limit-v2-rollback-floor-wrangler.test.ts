/** Pins the provider-enforced rollback floor that precedes direct v2 rate-limit routing. */

import { describe, expect, test } from "bun:test";

type DurableBinding = { name?: string; class_name?: string };
type DurableConfig = { bindings?: DurableBinding[] };
type WorkerConfig = {
  durable_objects?: DurableConfig;
  env?: {
    staging?: { durable_objects?: DurableConfig };
    production?: { durable_objects?: DurableConfig };
  };
  migrations?: Array<{
    tag?: string;
    new_sqlite_classes?: string[];
  }>;
};

describe("inference rate-limit v2 rollback floor", () => {
  test("exports a migration-only Durable Object class without a runtime binding", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as WorkerConfig;
    const entrypoint = await Bun.file(
      new URL("../src/index.ts", import.meta.url),
    ).text();

    expect(config.migrations).toContainEqual({
      tag: "inference-rate-limit-v2-rollback-floor-v1",
      new_sqlite_classes: ["InferenceRateLimitV2RollbackFloor"],
    });
    expect(entrypoint).toContain(
      'export { InferenceRateLimitV2RollbackFloor } from "./inference-rate-limit-v2-rollback-floor";',
    );

    for (const durableObjects of [
      config.durable_objects,
      config.env?.staging?.durable_objects,
      config.env?.production?.durable_objects,
    ]) {
      expect(durableObjects?.bindings ?? []).not.toContainEqual(
        expect.objectContaining({
          class_name: "InferenceRateLimitV2RollbackFloor",
        }),
      );
    }

    const productionReferences: string[] = [];
    const sourceRoot = new URL("../src/", import.meta.url).pathname;
    for await (const relativePath of new Bun.Glob("**/*.ts").scan({
      cwd: sourceRoot,
    })) {
      if (relativePath.endsWith(".test.ts")) continue;
      const source = await Bun.file(`${sourceRoot}${relativePath}`).text();
      if (source.includes("InferenceRateLimitV2RollbackFloor")) {
        productionReferences.push(relativePath);
      }
    }
    expect(productionReferences.sort()).toEqual([
      "index.ts",
      "inference-rate-limit-v2-rollback-floor.ts",
    ]);
  });
});
