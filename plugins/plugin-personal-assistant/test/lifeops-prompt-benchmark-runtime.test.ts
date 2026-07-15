/**
 * Verifies the benchmark's real PGLite runtime includes the production-owned
 * knowledge graph collaborator before LifeOps passive services handle turns.
 */
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { describe, expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

describe("LifeOps prompt benchmark runtime", () => {
  it("registers the runtime-owned knowledge graph service", async () => {
    const runtimeResult = await createLifeOpsTestRuntime();
    try {
      expect(
        resolveKnowledgeGraphService(runtimeResult.runtime),
      ).not.toBeNull();
    } finally {
      await runtimeResult.cleanup();
    }
  }, 180_000);
});
