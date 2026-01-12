import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubPluginConfig } from "../config";

describe("GitHub Config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should load config from environment variables", () => {
    process.env.GITHUB_API_TOKEN = "test_token";
    process.env.GITHUB_OWNER = "test_owner";
    process.env.GITHUB_REPO = "test_repo";
    process.env.GITHUB_BRANCH = "develop";

    const config = GitHubPluginConfig.fromEnv();

    expect(config.apiToken).toBe("test_token");
    expect(config.owner).toBe("test_owner");
    expect(config.repo).toBe("test_repo");
    expect(config.branch).toBe("develop");
  });

  it("should use default branch when not specified", () => {
    process.env.GITHUB_API_TOKEN = "test_token";
    delete process.env.GITHUB_BRANCH;

    const config = GitHubPluginConfig.fromEnv();

    expect(config.branch).toBe("main");
  });

  it("should throw error when API token is missing", () => {
    delete process.env.GITHUB_API_TOKEN;

    expect(() => GitHubPluginConfig.fromEnv()).toThrow();
  });
});
