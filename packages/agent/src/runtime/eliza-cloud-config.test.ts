import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { applyCloudConfigToEnv } from "./eliza.ts";

// applyCloudConfigToEnv is the #8769 source change: a cloud-provisioned container
// MUST use cloud (1536-dim) embeddings, never plugin-local-inference's 384-dim
// gte-small — otherwise every memory insert is dropped on a dimension mismatch.
// This was previously uncovered.
const ENV_KEYS = [
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZAOS_CLOUD_USE_INFERENCE",
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
  "ELIZAOS_CLOUD_USE_TTS",
  "ELIZAOS_CLOUD_USE_MEDIA",
  "ELIZAOS_CLOUD_USE_RPC",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_EMBEDDINGS_DISABLED",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("applyCloudConfigToEnv cloud-container embeddings (#8769)", () => {
  it("a cloud-provisioned container uses cloud embeddings and clears the disabled flag", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    // A stale disabled flag must be cleared, not left to suppress cloud embeddings.
    process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "true";

    applyCloudConfigToEnv({} as ElizaConfig);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBe("true");
    expect(process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED).toBeUndefined();
    // Cloud inference is likewise forced on for a provisioned container.
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBe("true");
  });

  it("is a no-op when neither cloud config nor ELIZA_CLOUD_PROVISIONED is present", () => {
    // No cloud + not a container → the function returns early and must not
    // touch any cloud-usage env (so a local-only agent isn't flipped to cloud).
    applyCloudConfigToEnv({} as ElizaConfig);

    expect(process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_USE_INFERENCE).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
  });
});
