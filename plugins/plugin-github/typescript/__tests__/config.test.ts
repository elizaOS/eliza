import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubPluginConfig, validateGitHubConfig } from "../config";
import { ConfigError, MissingSettingError } from "../error";

describe("GitHubPluginConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // fromEnv
  // =========================================================================
  describe("fromEnv", () => {
    it("should load all config from environment variables", () => {
      process.env.GITHUB_API_TOKEN = "ghp_testtoken123456";
      process.env.GITHUB_OWNER = "test-owner";
      process.env.GITHUB_REPO = "test-repo";
      process.env.GITHUB_BRANCH = "develop";
      process.env.GITHUB_WEBHOOK_SECRET = "whsec_123";
      process.env.GITHUB_APP_ID = "12345";
      process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
      process.env.GITHUB_INSTALLATION_ID = "99999";

      const config = GitHubPluginConfig.fromEnv();

      expect(config.apiToken).toBe("ghp_testtoken123456");
      expect(config.owner).toBe("test-owner");
      expect(config.repo).toBe("test-repo");
      expect(config.branch).toBe("develop");
      expect(config.webhookSecret).toBe("whsec_123");
      expect(config.appId).toBe("12345");
      expect(config.appPrivateKey).toBe("-----BEGIN RSA PRIVATE KEY-----");
      expect(config.installationId).toBe("99999");
    });

    it("should use default branch 'main' when GITHUB_BRANCH is not set", () => {
      process.env.GITHUB_API_TOKEN = "ghp_test";
      delete process.env.GITHUB_BRANCH;

      const config = GitHubPluginConfig.fromEnv();
      expect(config.branch).toBe("main");
    });

    it("should throw MissingSettingError when GITHUB_API_TOKEN is missing", () => {
      delete process.env.GITHUB_API_TOKEN;
      expect(() => GitHubPluginConfig.fromEnv()).toThrow(MissingSettingError);
    });

    it("should throw MissingSettingError when GITHUB_API_TOKEN is empty", () => {
      process.env.GITHUB_API_TOKEN = "";
      expect(() => GitHubPluginConfig.fromEnv()).toThrow();
    });

    it("should allow optional fields to be undefined", () => {
      process.env.GITHUB_API_TOKEN = "ghp_test";
      delete process.env.GITHUB_OWNER;
      delete process.env.GITHUB_REPO;
      delete process.env.GITHUB_WEBHOOK_SECRET;
      delete process.env.GITHUB_APP_ID;

      const config = GitHubPluginConfig.fromEnv();
      expect(config.owner).toBeUndefined();
      expect(config.repo).toBeUndefined();
      expect(config.webhookSecret).toBeUndefined();
      expect(config.appId).toBeUndefined();
    });
  });

  // =========================================================================
  // fromSettings
  // =========================================================================
  describe("fromSettings", () => {
    it("should create config from a GitHubSettings object", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_fromSettings",
        owner: "settings-owner",
        repo: "settings-repo",
        branch: "release",
      });

      expect(config.apiToken).toBe("ghp_fromSettings");
      expect(config.owner).toBe("settings-owner");
      expect(config.repo).toBe("settings-repo");
      expect(config.branch).toBe("release");
    });

    it("should default branch to 'main' when not provided", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
      });
      expect(config.branch).toBe("main");
    });

    it("should throw when apiToken is empty", () => {
      expect(() => GitHubPluginConfig.fromSettings({ apiToken: "" })).toThrow();
    });
  });

  // =========================================================================
  // fromRuntime
  // =========================================================================
  describe("fromRuntime", () => {
    function mockRuntime(settings: Record<string, string | null>) {
      return {
        getSetting: vi.fn((key: string) => settings[key] ?? null),
      };
    }

    it("should create config from runtime settings", () => {
      const runtime = mockRuntime({
        GITHUB_API_TOKEN: "ghp_runtime_token",
        GITHUB_OWNER: "rt-owner",
        GITHUB_REPO: "rt-repo",
        GITHUB_BRANCH: "staging",
      });

      const config = GitHubPluginConfig.fromRuntime(runtime as never);

      expect(config.apiToken).toBe("ghp_runtime_token");
      expect(config.owner).toBe("rt-owner");
      expect(config.repo).toBe("rt-repo");
      expect(config.branch).toBe("staging");
    });

    it("should throw MissingSettingError when GITHUB_API_TOKEN is missing from runtime", () => {
      const runtime = mockRuntime({});
      expect(() => GitHubPluginConfig.fromRuntime(runtime as never)).toThrow(MissingSettingError);
    });

    it("should default branch to 'main' when not in runtime settings", () => {
      const runtime = mockRuntime({
        GITHUB_API_TOKEN: "ghp_test",
      });

      const config = GitHubPluginConfig.fromRuntime(runtime as never);
      expect(config.branch).toBe("main");
    });
  });

  // =========================================================================
  // getRepositoryRef
  // =========================================================================
  describe("getRepositoryRef", () => {
    it("should return configured defaults", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        owner: "default-owner",
        repo: "default-repo",
      });

      const ref = config.getRepositoryRef();
      expect(ref.owner).toBe("default-owner");
      expect(ref.repo).toBe("default-repo");
    });

    it("should override defaults with explicit values", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        owner: "default-owner",
        repo: "default-repo",
      });

      const ref = config.getRepositoryRef("override-owner", "override-repo");
      expect(ref.owner).toBe("override-owner");
      expect(ref.repo).toBe("override-repo");
    });

    it("should support partial overrides", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        owner: "default-owner",
        repo: "default-repo",
      });

      const ref = config.getRepositoryRef("override-owner");
      expect(ref.owner).toBe("override-owner");
      expect(ref.repo).toBe("default-repo");
    });

    it("should throw MissingSettingError when owner is not configured", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        repo: "some-repo",
      });

      expect(() => config.getRepositoryRef()).toThrow(MissingSettingError);
    });

    it("should throw MissingSettingError when repo is not configured", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        owner: "some-owner",
      });

      expect(() => config.getRepositoryRef()).toThrow(MissingSettingError);
    });
  });

  // =========================================================================
  // hasAppAuth
  // =========================================================================
  describe("hasAppAuth", () => {
    it("should return true when both appId and appPrivateKey are set", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        appId: "123",
        appPrivateKey: "key",
        installationId: "456",
      });
      expect(config.hasAppAuth()).toBe(true);
    });

    it("should return false when appId is missing", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        appPrivateKey: "key",
      });
      expect(config.hasAppAuth()).toBe(false);
    });

    it("should return false when appPrivateKey is missing", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        appId: "123",
      });
      expect(config.hasAppAuth()).toBe(false);
    });

    it("should return false when both are missing", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
      });
      expect(config.hasAppAuth()).toBe(false);
    });
  });

  // =========================================================================
  // validate
  // =========================================================================
  describe("validate", () => {
    it("should not throw for valid token prefixes", () => {
      for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]) {
        const config = GitHubPluginConfig.fromSettings({
          apiToken: `${prefix}test123`,
        });
        expect(() => config.validate()).not.toThrow();
      }
    });

    it("should warn but not throw for unrecognized token format", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "some_other_token_format",
      });
      config.validate();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not recognized"));
      consoleSpy.mockRestore();
    });

    it("should throw ConfigError when app auth is set without installationId", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        appId: "123",
        appPrivateKey: "key",
      });
      expect(() => config.validate()).toThrow(ConfigError);
    });

    it("should not throw when app auth is set with installationId", () => {
      const config = GitHubPluginConfig.fromSettings({
        apiToken: "ghp_test",
        appId: "123",
        appPrivateKey: "key",
        installationId: "456",
      });
      expect(() => config.validate()).not.toThrow();
    });
  });

  // =========================================================================
  // toSettings
  // =========================================================================
  describe("toSettings", () => {
    it("should round-trip through toSettings", () => {
      const original = {
        apiToken: "ghp_roundtrip",
        owner: "rt-owner",
        repo: "rt-repo",
        branch: "develop",
        webhookSecret: "secret",
        appId: "app1",
        appPrivateKey: "pk1",
        installationId: "inst1",
      };

      const config = GitHubPluginConfig.fromSettings(original);
      const settings = config.toSettings();

      expect(settings.apiToken).toBe(original.apiToken);
      expect(settings.owner).toBe(original.owner);
      expect(settings.repo).toBe(original.repo);
      expect(settings.branch).toBe(original.branch);
      expect(settings.webhookSecret).toBe(original.webhookSecret);
      expect(settings.appId).toBe(original.appId);
      expect(settings.appPrivateKey).toBe(original.appPrivateKey);
      expect(settings.installationId).toBe(original.installationId);
    });
  });

  // =========================================================================
  // validateGitHubConfig helper
  // =========================================================================
  describe("validateGitHubConfig", () => {
    it("should return a validated config", () => {
      const runtime = {
        getSetting: vi.fn((key: string) => {
          const map: Record<string, string> = {
            GITHUB_API_TOKEN: "ghp_validtoken",
            GITHUB_OWNER: "owner",
            GITHUB_REPO: "repo",
          };
          return map[key] ?? null;
        }),
      };

      const config = validateGitHubConfig(runtime as never);
      expect(config.apiToken).toBe("ghp_validtoken");
    });
  });
});
