/** Exercises the real hosted settings builder so embedding model and database width agree. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentMode } from "../agent-mode-types";
import type { UserContext } from "../user-context";
import { buildSettings } from "./settings";

const context: UserContext = {
  userId: "embedding-test-user",
  entityId: "embedding-test-user",
  organizationId: "embedding-test-org",
  agentMode: AgentMode.CHAT,
  apiKey: "synthetic-test-key",
  isAnonymous: false,
};
let previousModel: string | undefined;
beforeEach(() => {
  previousModel = process.env.ELIZAOS_CLOUD_EMBEDDING_MODEL;
  delete process.env.ELIZAOS_CLOUD_EMBEDDING_MODEL;
});
afterEach(() => {
  if (previousModel === undefined) delete process.env.ELIZAOS_CLOUD_EMBEDDING_MODEL;
  else process.env.ELIZAOS_CLOUD_EMBEDDING_MODEL = previousModel;
});

describe("hosted embedding configuration", () => {
  test("uses the shared BGE model and its width for an unconfigured character", () => {
    const settings = buildSettings({ name: "Embedding test" }, context);
    expect(settings.ELIZAOS_CLOUD_EMBEDDING_MODEL).toBe("bge-small-en-v1.5");
    expect(settings.EMBEDDING_DIMENSION).toBe("384");
  });

  test("keeps an explicit cloud model and its matching width", () => {
    const settings = buildSettings(
      {
        name: "Embedding test",
        settings: { ELIZAOS_CLOUD_EMBEDDING_MODEL: "text-embedding-3-small" },
      },
      context,
    );
    expect(settings.ELIZAOS_CLOUD_EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(settings.EMBEDDING_DIMENSION).toBe("1536");
  });

  test("applies the legacy explicit model consistently to the cloud handler", () => {
    const settings = buildSettings(
      { name: "Embedding test", settings: { OPENAI_EMBEDDING_MODEL: "text-embedding-3-large" } },
      context,
    );
    expect(settings.ELIZAOS_CLOUD_EMBEDDING_MODEL).toBe("text-embedding-3-large");
    expect(settings.EMBEDDING_DIMENSION).toBe("3072");
  });

  test("uses the environment model for both the handler and database width", () => {
    process.env.ELIZAOS_CLOUD_EMBEDDING_MODEL = "text-embedding-3-large";
    const settings = buildSettings({ name: "Embedding test" }, context);
    expect(settings.ELIZAOS_CLOUD_EMBEDDING_MODEL).toBe("text-embedding-3-large");
    expect(settings.EMBEDDING_DIMENSION).toBe("3072");
  });

  test("rejects malformed explicit model settings before runtime setup", () => {
    expect(() =>
      buildSettings(
        { name: "Embedding test", settings: { ELIZAOS_CLOUD_EMBEDDING_MODEL: 384 } },
        context,
      ),
    ).toThrow("Configure the embedding model");
  });
});
