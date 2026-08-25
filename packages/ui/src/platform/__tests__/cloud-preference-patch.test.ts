/**
 * Unit tests for cloud preference patching and local provider configuration normalization.
 */
import { describe, expect, it, vi } from "vitest";
import {
  installLocalProviderCloudPreferencePatch,
  normalizeConfigForLocalProviderPreference,
  shouldPreferLocalProviderConfig,
} from "../cloud-preference-patch.ts";
import type { CloudPreferenceClientLike } from "../types.ts";

describe("cloud-preference-patch", () => {
  describe("shouldPreferLocalProviderConfig", () => {
    it("returns false for null, undefined, or empty config", () => {
      expect(shouldPreferLocalProviderConfig(null)).toBe(false);
      expect(shouldPreferLocalProviderConfig(undefined)).toBe(false);
      expect(shouldPreferLocalProviderConfig({})).toBe(false);
    });

    it("returns false when llmText transport is cloud-proxy", () => {
      const config = {
        serviceRouting: {
          llmText: { backend: "elizacloud", transport: "cloud-proxy" },
        },
      };
      expect(shouldPreferLocalProviderConfig(config)).toBe(false);
    });

    it("returns true when direct provider is configured with inactive cloud signals and no remote connection", () => {
      const config = {
        serviceRouting: {
          llmText: { backend: "anthropic", transport: "direct" },
        },
        cloud: {
          apiKey: "sk-cloud-test",
          services: { inference: false },
        },
        deploymentTarget: {
          runtime: "local",
        },
      };
      expect(shouldPreferLocalProviderConfig(config)).toBe(true);
    });
  });

  describe("normalizeConfigForLocalProviderPreference", () => {
    it("preserves apiKey while stripping other cloud capability flags", () => {
      const config = {
        serviceRouting: {
          llmText: { backend: "anthropic", transport: "direct" },
        },
        cloud: {
          apiKey: "sk-cloud-key-123",
          enabled: true,
          provider: "elizacloud",
          inferenceMode: "hybrid",
        },
        deploymentTarget: {
          runtime: "local",
        },
      };

      const normalized = normalizeConfigForLocalProviderPreference(config);
      expect(normalized?.cloud).toEqual({ apiKey: "sk-cloud-key-123" });
    });

    it("returns unmodified config when local provider preference does not apply", () => {
      const config = {
        serviceRouting: {
          llmText: { backend: "elizacloud", transport: "cloud-proxy" },
        },
        cloud: { apiKey: "key" },
      };
      expect(normalizeConfigForLocalProviderPreference(config)).toEqual(config);
    });
  });

  describe("installLocalProviderCloudPreferencePatch", () => {
    it("patches client.getConfig to normalize config on read and uninstalls cleanly", async () => {
      const mockRawConfig = {
        serviceRouting: {
          llmText: { backend: "anthropic", transport: "direct" },
        },
        cloud: {
          apiKey: "sk-test",
          provider: "elizacloud",
        },
        deploymentTarget: { runtime: "local" },
      };

      const originalGetConfig = vi.fn().mockResolvedValue(mockRawConfig);
      const client: CloudPreferenceClientLike = {
        getConfig: originalGetConfig,
      };

      const uninstall = installLocalProviderCloudPreferencePatch(client);

      const patchedResult = await client.getConfig();
      expect(patchedResult.cloud).toEqual({ apiKey: "sk-test" });

      uninstall();
      const revertedResult = await client.getConfig();
      expect(revertedResult).toEqual(mockRawConfig);
    });
  });
});
