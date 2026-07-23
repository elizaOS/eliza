/**
 * `applyCloudProxyTextRouting` (warm-pool claim re-credential, F0).
 *
 * The warm-claim inference re-key calls `POST /api/cloud/login/persist` with
 * `forceInferenceEnabled: true`, which pins the ElizaCloud cloud-proxy text
 * route into the container's config so a subsequent restart's config-derived
 * `isCloudInferenceSelectedInConfig` agrees with the managed env and inference
 * stays enabled without another push. These tests pin the round trip:
 *   - after applying the routing, `isCloudInferenceSelectedInConfig` is true;
 *   - the write is additive (existing serviceRouting fields survive);
 *   - it does not clobber unrelated config keys.
 * [sol-warmpool-keypush]
 */

import { describe, expect, test } from "bun:test";
import { isCloudInferenceSelectedInConfig } from "@elizaos/core";
import { applyCloudProxyTextRouting } from "../../src/routes/cloud-routes";

describe("applyCloudProxyTextRouting", () => {
  test("makes isCloudInferenceSelectedInConfig true on an empty config", () => {
    const config: Record<string, unknown> = {};
    expect(isCloudInferenceSelectedInConfig(config)).toBe(false);

    applyCloudProxyTextRouting(config);

    expect(isCloudInferenceSelectedInConfig(config)).toBe(true);
    expect(config.serviceRouting).toEqual({
      llmText: {
        backend: "elizacloud",
        transport: "cloud-proxy",
        accountId: "elizacloud",
      },
    });
  });

  test("preserves existing serviceRouting siblings (additive)", () => {
    const config: Record<string, unknown> = {
      serviceRouting: {
        embeddings: { backend: "elizacloud", transport: "cloud-proxy" },
      },
      cloud: { apiKey: "eliza_existing" },
    };

    applyCloudProxyTextRouting(config);

    const routing = config.serviceRouting as Record<string, unknown>;
    // Existing embeddings route untouched.
    expect(routing.embeddings).toEqual({
      backend: "elizacloud",
      transport: "cloud-proxy",
    });
    // llmText now cloud-proxy.
    expect(routing.llmText).toEqual({
      backend: "elizacloud",
      transport: "cloud-proxy",
      accountId: "elizacloud",
    });
    // Unrelated config preserved.
    expect(config.cloud).toEqual({ apiKey: "eliza_existing" });
    expect(isCloudInferenceSelectedInConfig(config)).toBe(true);
  });

  test("overwrites a prior non-cloud llmText route (re-credential wins)", () => {
    const config: Record<string, unknown> = {
      serviceRouting: {
        llmText: { backend: "ollama", transport: "direct" },
      },
    };
    expect(isCloudInferenceSelectedInConfig(config)).toBe(false);

    applyCloudProxyTextRouting(config);

    expect(isCloudInferenceSelectedInConfig(config)).toBe(true);
    expect((config.serviceRouting as Record<string, unknown>).llmText).toEqual({
      backend: "elizacloud",
      transport: "cloud-proxy",
      accountId: "elizacloud",
    });
  });
});
