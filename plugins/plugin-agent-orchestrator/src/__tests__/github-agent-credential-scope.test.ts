/**
 * Git subprocess credential isolation for multi-agent hosts.
 * Ambient host tokens must be stripped, while an explicitly resolved runtime
 * token is transported only through the scoped GitHub HTTP header.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildGitHubProcessEnv } from "../services/workspace-service.js";

const original = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GH_TOKEN: process.env.GH_TOKEN,
  CR_PAT: process.env.CR_PAT,
};

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("buildGitHubProcessEnv", () => {
  it("strips every ambient GitHub credential when the agent has none", () => {
    process.env.GITHUB_TOKEN = "host-github";
    process.env.GH_TOKEN = "host-gh";
    process.env.CR_PAT = "host-cr";
    const env = buildGitHubProcessEnv("https://github.com/elizaOS/eliza.git");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.CR_PAT).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it("injects only the selected agent token into Git's scoped header", () => {
    process.env.GITHUB_TOKEN = "host-token";
    const env = buildGitHubProcessEnv(
      "https://github.com/elizaOS/eliza.git",
      "agent-token",
    );
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    const encoded = String(env.GIT_CONFIG_VALUE_0).replace(
      "Authorization: Basic ",
      "",
    );
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
      "x-access-token:agent-token",
    );
  });

  it("does not inject the agent token into a non-GitHub remote", () => {
    const env = buildGitHubProcessEnv(
      "https://gitlab.com/example/repo.git",
      "agent-token",
    );
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });
});
