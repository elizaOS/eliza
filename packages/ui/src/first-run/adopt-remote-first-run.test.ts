/**
 * Unit coverage for adopting a remote agent's first-run state (URL
 * normalization, config probe). Client injected, no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import {
  adoptRemoteAgentFirstRun,
  normalizeRemoteAgentUrl,
  type RemoteFirstRunClient,
} from "./adopt-remote-first-run";

describe("normalizeRemoteAgentUrl", () => {
  it("keeps a valid http URL and strips the trailing slash", () => {
    expect(normalizeRemoteAgentUrl("http://127.0.0.1:31337/")).toBe(
      "http://127.0.0.1:31337",
    );
  });

  it("upgrades a bare host to https", () => {
    expect(normalizeRemoteAgentUrl("agent.example.com")).toBe(
      "https://agent.example.com",
    );
  });

  it("strips query and hash so one host has one identity", () => {
    expect(normalizeRemoteAgentUrl("https://agent.example.com/?x=1#frag")).toBe(
      "https://agent.example.com",
    );
  });

  it("throws on an empty value", () => {
    expect(() => normalizeRemoteAgentUrl("   ")).toThrow(
      /enter a remote agent url/i,
    );
  });

  it("rejects a non-http(s) protocol", () => {
    expect(() => normalizeRemoteAgentUrl("ftp://agent.example.com")).toThrow(
      /http or https/i,
    );
  });
});

function makeClient(overrides: Partial<RemoteFirstRunClient> = {}): {
  client: RemoteFirstRunClient;
  getFirstRunStatus: ReturnType<typeof vi.fn>;
  submitFirstRun: ReturnType<typeof vi.fn>;
} {
  const getFirstRunStatus = vi.fn(async () => ({ complete: false }));
  const submitFirstRun = vi.fn(async () => undefined);
  const client: RemoteFirstRunClient = {
    getFirstRunStatus,
    submitFirstRun,
    ...overrides,
  };
  return { client, getFirstRunStatus, submitFirstRun };
}

describe("adoptRemoteAgentFirstRun", () => {
  it("adopts a fresh remote: probes then POSTs the remote deployment target", async () => {
    const { client, submitFirstRun } = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: false })),
    });

    const result = await adoptRemoteAgentFirstRun(client, {
      apiBase: "http://127.0.0.1:31337",
    });

    expect(result).toEqual({ alreadyComplete: false });
    expect(submitFirstRun).toHaveBeenCalledTimes(1);
    const payload = submitFirstRun.mock.calls[0][0] as {
      deploymentTarget?: { runtime?: string; remoteApiBase?: string };
    };
    expect(payload.deploymentTarget?.runtime).toBe("remote");
    expect(payload.deploymentTarget?.remoteApiBase).toBe(
      "http://127.0.0.1:31337",
    );
  });

  it("does NOT clobber a host that already finished first-run", async () => {
    const { client, submitFirstRun } = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: true })),
    });

    const result = await adoptRemoteAgentFirstRun(client, {
      apiBase: "https://agent.example.com",
    });

    expect(result).toEqual({ alreadyComplete: true });
    expect(submitFirstRun).not.toHaveBeenCalled();
  });

  it("treats an unreachable status probe as 'needs adoption' and still POSTs", async () => {
    const { client, submitFirstRun } = makeClient({
      getFirstRunStatus: vi.fn(async () => {
        throw new Error("network down");
      }),
    });

    await adoptRemoteAgentFirstRun(client, {
      apiBase: "http://127.0.0.1:31337",
    });

    expect(submitFirstRun).toHaveBeenCalledTimes(1);
  });

  it("propagates a completion-write failure instead of faking success", async () => {
    const { client } = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: false })),
      submitFirstRun: vi.fn(async () => {
        throw new Error("remote unreachable");
      }),
    });

    await expect(
      adoptRemoteAgentFirstRun(client, { apiBase: "http://127.0.0.1:31337" }),
    ).rejects.toThrow(/remote unreachable/);
  });

  it("forwards an access token in the submitted plan", async () => {
    const { client, submitFirstRun } = makeClient();

    await adoptRemoteAgentFirstRun(client, {
      apiBase: "https://agent.example.com",
      token: "secret-key",
    });

    const payload = submitFirstRun.mock.calls[0][0] as {
      deploymentTarget?: { remoteAccessToken?: string };
    };
    expect(payload.deploymentTarget?.remoteAccessToken).toBe("secret-key");
  });
});
