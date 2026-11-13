/**
 * A TEXT_EMBEDDING probe that fails for a reason unrelated to embeddings means
 * the run is broken, not that the environment cannot host ConfigBench: the
 * setup path already separates the two (see isTextEmbeddingSetupFailure).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
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

test("an unavailable embedding provider stays setup incompatible", async () => {
  await assert.rejects(
    () =>
      assertTextEmbeddingUsable(
        runtimeWhoseProbeFails(
          new ElizaError("No embedding endpoint is configured", {
            code: "EMBEDDING_PROVIDER_UNAVAILABLE",
          }),
        ),
      ),
    (error: unknown) => {
      assert.equal(isSetupIncompatibleError(error), true);
      return true;
    },
  );
});

for (const status of [429, 500]) {
  test(`an OpenAI embedding HTTP ${status} fails the run`, async () => {
    const failure = new Error(
      `OpenAI embedding API error: ${status} provider failure`,
    );
    await assert.rejects(
      () => assertTextEmbeddingUsable(runtimeWhoseProbeFails(failure)),
      (error: unknown) => error === failure && !isSetupIncompatibleError(error),
    );
  });
}

test("a missing local embedding capability stays setup incompatible", async () => {
  const failure = Object.assign(
    new Error("Local backend does not implement TEXT_EMBEDDING"),
    {
      code: "LOCAL_INFERENCE_UNAVAILABLE",
      modelType: "TEXT_EMBEDDING",
      reason: "capability_unavailable",
    },
  );
  await assert.rejects(
    () => assertTextEmbeddingUsable(runtimeWhoseProbeFails(failure)),
    isSetupIncompatibleError,
  );
});

test("invalid local embedding output fails the run", async () => {
  const failure = Object.assign(
    new Error("TEXT_EMBEDDING backend returned invalid output"),
    {
      code: "LOCAL_INFERENCE_UNAVAILABLE",
      modelType: "TEXT_EMBEDDING",
      reason: "invalid_output",
    },
  );
  await assert.rejects(
    () => assertTextEmbeddingUsable(runtimeWhoseProbeFails(failure)),
    (error: unknown) => error === failure && !isSetupIncompatibleError(error),
  );
});
