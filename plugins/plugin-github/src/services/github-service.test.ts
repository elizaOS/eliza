import { describe, expect, it, vi } from "vitest";
import { GitHubService } from "./github-service";

describe("GitHubService account selection", () => {
  it("returns null when no account is configured for the role (fail-closed)", () => {
    const service = new GitHubService();
    expect(service.getOctokit("user")).toBeNull();
  });

  it("returns the client for a configured user account", () => {
    const service = new GitHubService();
    const client = { auth: "token-1" };
    service.setClientForTesting("user", client);
    expect(service.getOctokit("user")).toBe(client);
  });

  it("returns the client for a configured agent account", () => {
    const service = new GitHubService();
    const client = { auth: "token-2" };
    service.setClientForTesting("agent", client);
    expect(service.getOctokit("agent")).toBe(client);
  });

  it("resolves an explicit accountId with surrounding whitespace trimmed", () => {
    const service = new GitHubService();
    const client = { auth: "token-3" };
    service.setClientForTesting("user", client, "user");
    expect(service.getOctokit({ accountId: "  user  " })).toBe(client);
  });

  it("does not silently fall back to another account for an unknown accountId", () => {
    const service = new GitHubService();
    service.setClientForTesting("user", { auth: "token" }, "user");
    expect(service.getOctokit({ accountId: "ghost" })).toBeNull();
  });

  it("defaults object selectors without an explicit role to agent", () => {
    const service = new GitHubService();
    const agentClient = { auth: "agent-token" };
    const userClient = { auth: "user-token" };
    service.setClientForTesting("agent", agentClient, "agent");
    service.setClientForTesting("user", userClient, "user");
    expect(service.getOctokit({})).toBe(agentClient);
  });

  it("prefers an explicit role over the as-shorthand when both are present", () => {
    const service = new GitHubService();
    const agentClient = { auth: "agent-token" };
    const userClient = { auth: "user-token" };
    service.setClientForTesting("agent", agentClient, "agent");
    service.setClientForTesting("user", userClient, "user");
    expect(service.getOctokit({ as: "user", role: "agent" })).toBe(agentClient);
  });

  it("clears all clients on stop (no stale tokens survive)", async () => {
    const service = new GitHubService();
    service.setClientForTesting("user", { auth: "t" }, "user");
    await service.stop();
    expect(service.getOctokit("user")).toBeNull();
  });

  it("removes a client when setClientForTesting is called with null", () => {
    const service = new GitHubService();
    service.setClientForTesting("user", { auth: "t" }, "user");
    service.setClientForTesting("user", null, "user");
    expect(service.getOctokit("user")).toBeNull();
  });

  it("uses the createClient factory when initializing from connector credentials", async () => {
    const createClient = vi.fn((auth: string) => ({ auth }));
    const service = new GitHubService(undefined, createClient);
    service.setClientForTesting("agent", { auth: "injected" }, "agent");
    expect(service.getOctokit("agent")).toEqual({ auth: "injected" });
    // The injected path must not have gone through the factory.
    expect(createClient).not.toHaveBeenCalled();
  });
});
