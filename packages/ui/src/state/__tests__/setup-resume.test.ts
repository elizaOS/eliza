/**
 * Unit tests for onboarding resume derivation from partial server config.
 */
import { describe, expect, it } from "vitest";
import {
  deriveFirstRunResumeFieldsFromConfig,
  hasPartialSetupConnectionConfig,
} from "../setup-resume.ts";

describe("setup-resume", () => {
  describe("hasPartialSetupConnectionConfig", () => {
    it("returns false for null, undefined, or empty config", () => {
      expect(hasPartialSetupConnectionConfig(null)).toBe(false);
      expect(hasPartialSetupConnectionConfig(undefined)).toBe(false);
      expect(hasPartialSetupConnectionConfig({})).toBe(false);
    });

    it("returns true when serviceRouting is configured", () => {
      const config = {
        serviceRouting: {
          llmText: { backend: "elizacloud", transport: "cloud-proxy" },
        },
      };
      expect(hasPartialSetupConnectionConfig(config)).toBe(true);
    });

    it("returns true when deploymentTarget is not local", () => {
      const config = {
        deploymentTarget: {
          runtime: "remote",
          remoteApiBase: "https://agent.example.com",
        },
      };
      expect(hasPartialSetupConnectionConfig(config)).toBe(true);
    });

    it("returns true when linkedAccounts is present in config root", () => {
      const config = {
        linkedAccounts: {
          discord: { enabled: true },
        },
      };
      expect(hasPartialSetupConnectionConfig(config)).toBe(true);
    });
  });

  describe("deriveFirstRunResumeFieldsFromConfig", () => {
    it("derives default empty fields when config is empty", () => {
      const result = deriveFirstRunResumeFieldsFromConfig({});
      expect(result).toEqual({
        firstRunRuntimeTarget: "local",
        firstRunProvider: "",
        firstRunRemoteConnected: false,
        firstRunRemoteApiBase: "",
        firstRunRemoteToken: "",
      });
    });

    it("derives remote connection fields when remote deploymentTarget is set", () => {
      const config = {
        deploymentTarget: {
          runtime: "remote",
          remoteApiBase: "https://remote.agent.app",
          remoteAccessToken: "secret-token-123",
        },
      };
      const result = deriveFirstRunResumeFieldsFromConfig(config);
      expect(result).toEqual({
        firstRunRuntimeTarget: "remote",
        firstRunProvider: "",
        firstRunRemoteConnected: true,
        firstRunRemoteApiBase: "https://remote.agent.app",
        firstRunRemoteToken: "secret-token-123",
      });
    });

    it("derives elizacloud provider when cloud-proxy transport is configured", () => {
      const config = {
        serviceRouting: {
          llmText: {
            backend: "elizacloud",
            transport: "cloud-proxy",
          },
        },
      };
      const result = deriveFirstRunResumeFieldsFromConfig(config);
      expect(result.firstRunProvider).toBe("elizacloud");
    });

    it("derives non-cloud provider directly from backend routing", () => {
      const config = {
        serviceRouting: {
          llmText: {
            backend: "anthropic",
            transport: "direct",
          },
        },
      };
      const result = deriveFirstRunResumeFieldsFromConfig(config);
      expect(result.firstRunProvider).toBe("anthropic");
    });
  });
});
