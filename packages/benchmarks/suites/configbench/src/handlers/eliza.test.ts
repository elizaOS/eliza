/**
 * A TEXT_EMBEDDING probe that fails for a reason unrelated to embeddings means
 * the run is broken, not that the environment cannot host ConfigBench: the
 * setup path already separates the two (see isTextEmbeddingSetupFailure).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { IAgentRuntime } from "@elizaos/core";
import { isSetupIncompatibleError } from "../setup-incompatible.js";
import { assertTextEmbeddingUsable } from "./eliza.js";

function runtimeWhoseProbeFails(error: Error): IAgentRuntime {
  return {
    getModel: () => ({ modelName: "probe" }),
    useModel: async () => {
      throw error;
    },
  } as unknown as IAgentRuntime;
}

test("an adapter failure during the embedding probe fails the run", async () => {
  const failure = new Error("SQLITE_BUSY: database is locked");

  await assert.rejects(
    () => assertTextEmbeddingUsable(runtimeWhoseProbeFails(failure)),
    (error: unknown) => {
      assert.equal(
        isSetupIncompatibleError(error),
        false,
        `probe failure was reported as setup incompatible: ${String(error)}`,
      );
      assert.equal(error, failure);
      return true;
    },
  );
});

test("an embedding-specific probe failure stays setup incompatible", async () => {
  await assert.rejects(
    () =>
      assertTextEmbeddingUsable(
        runtimeWhoseProbeFails(
          new Error("TEXT_EMBEDDING: LOCAL_INFERENCE_UNAVAILABLE"),
        ),
      ),
    (error: unknown) => {
      assert.equal(isSetupIncompatibleError(error), true);
      return true;
    },
  );
});
