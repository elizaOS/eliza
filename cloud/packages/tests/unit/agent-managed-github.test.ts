import { describe, expect, test } from "bun:test";
import {
  AGENT_CHARACTER_OWNERSHIP_KEY,
  readManagedAgentGithubBinding,
  withManagedAgentGithubBinding,
  withoutManagedAgentGithubBinding,
} from "@/lib/services/eliza-agent-config";

describe("managed Eliza GitHub config helpers", () => {
  test("writes and reads the managed GitHub binding payload", () => {
    const config = withManagedAgentGithubBinding(
      {
        existing: true,
        [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
      },
      {
        mode: "cloud-managed",
        connectionId: "conn-1",
        githubUserId: "12345",
        githubUsername: "octocat",
        githubDisplayName: "The Octocat",
        githubAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
        githubEmail: "octocat@github.com",
        scopes: ["repo", "read:user", "user:email"],
        adminElizaUserId: "user-1",
        connectedAt: "2026-04-05T16:00:00.000Z",
      },
    );

    expect(readManagedAgentGithubBinding(config)).toEqual({
      mode: "cloud-managed",
      connectionId: "conn-1",
      githubUserId: "12345",
      githubUsername: "octocat",
      githubDisplayName: "The Octocat",
      githubAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
      githubEmail: "octocat@github.com",
      scopes: ["repo", "read:user", "user:email"],
      adminElizaUserId: "user-1",
      connectedAt: "2026-04-05T16:00:00.000Z",
    });
    expect(config[AGENT_CHARACTER_OWNERSHIP_KEY]).toBe("reuse-existing");
  });

  test("removes only the managed GitHub binding", () => {
    const config = withoutManagedAgentGithubBinding({
      existing: true,
      [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
      __agentManagedGithub: {
        connectionId: "conn-1",
        githubUserId: "12345",
        githubUsername: "octocat",
        scopes: ["repo"],
        adminElizaUserId: "user-1",
        connectedAt: "2026-04-05T16:00:00.000Z",
      },
    });

    expect(readManagedAgentGithubBinding(config)).toBeNull();
    expect(config).toEqual({
      existing: true,
      [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
    });
  });

  test("returns null for missing or incomplete binding", () => {
    expect(readManagedAgentGithubBinding(null)).toBeNull();
    expect(readManagedAgentGithubBinding({})).toBeNull();
    expect(
      readManagedAgentGithubBinding({
        __agentManagedGithub: { githubUserId: "12345" },
      }),
    ).toBeNull();
  });
});
