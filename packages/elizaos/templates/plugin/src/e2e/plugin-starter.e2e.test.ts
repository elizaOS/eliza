import { describe, it } from "vitest";
import { cleanupTestRuntime, createTestRuntime } from "../__tests__/test-utils";
import plugin from "../plugin";
import { StarterPluginTestSuite } from "./plugin-starter.e2e";

describe(StarterPluginTestSuite.name, () => {
  for (const suiteTest of StarterPluginTestSuite.tests) {
    it(suiteTest.name, async () => {
      const runtime = await createTestRuntime({
        character: { name: "Eliza" },
        plugins: [plugin],
      });

      try {
        await suiteTest.fn(runtime);
      } finally {
        await cleanupTestRuntime(runtime);
      }
    });
  }
});
