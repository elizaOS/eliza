/**
 * Agent-scoped binding of the cloud-managed GitHub OAuth token (#15904).
 *
 * Exercises `autoFetchCloudGithubToken` against a stubbed global `fetch` and
 * `bindCloudGithubTokenToRuntime` against minimal in-memory runtimes.
 * Deterministic, no network. The load-bearing contract under test: the fetch
 * NEVER writes `process.env.GITHUB_TOKEN`, the bind lands the token only in
 * the owning runtime's secrets, and a co-tenant runtime in the same process
 * can neither observe nor be overwritten by another agent's token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoFetchCloudGithubToken,
  bindCloudGithubTokenToRuntime,
} from "./eliza.ts";

const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GITHUB_PAT",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT",
  "ELIZAOS_CLOUD_MANAGED_AGENTS_API_SEGMENT",
] as const;

const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

function fakeRuntime(initialSecrets: Record<string, string> = {}) {
  const secrets: Record<string, string> = { ...initialSecrets };
  return {
    secrets,
    getSetting: (key: string) => secrets[key] ?? null,
    setSetting: (
      key: string,
      value: string | boolean | null,
      secret = false,
    ) => {
      void secret;
      if (value === null) delete secrets[key];
      else secrets[key] = String(value);
    },
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function armCloudEnv() {
  process.env.ELIZAOS_CLOUD_API_KEY = "test-cloud-key";
  process.env.ELIZAOS_CLOUD_BASE_URL = "https://cloud.test";
  process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT = "managed";
}

describe("autoFetchCloudGithubToken", () => {
  it("returns the token without writing process.env.GITHUB_TOKEN", async () => {
    armCloudEnv();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { accessToken: "gho_agent_a", githubUsername: "octo-a" },
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await autoFetchCloudGithubToken("agent-a");

    expect(result).toEqual({
      accessToken: "gho_agent_a",
      githubUsername: "octo-a",
    });
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    const requestedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestedUrl).toBe(
      "https://cloud.test/api/v1/managed/agents/agent-a/github/token",
    );
  });

  it("skips the fetch entirely when a host env token is present", async () => {
    armCloudEnv();
    process.env.GITHUB_TOKEN = "host-level-token";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await autoFetchCloudGithubToken("agent-a")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.env.GITHUB_TOKEN).toBe("host-level-token");
  });

  it("returns null (no env mutation) on 404, non-OK, and malformed bodies", async () => {
    armCloudEnv();
    const cases = [
      new Response("", { status: 404 }),
      new Response("", { status: 500 }),
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
      }),
    ];
    for (const response of cases) {
      globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch;
      expect(await autoFetchCloudGithubToken("agent-a")).toBeNull();
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
    }
  });

  it("returns null without fetching when cloud credentials or agent id are absent", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await autoFetchCloudGithubToken("agent-a")).toBeNull();
    armCloudEnv();
    expect(await autoFetchCloudGithubToken(undefined)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the network fetch rejects", async () => {
    armCloudEnv();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await autoFetchCloudGithubToken("agent-a")).toBeNull();
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });
});

describe("bindCloudGithubTokenToRuntime", () => {
  it("binds the token into the owning runtime's secrets only", () => {
    const runtimeA = fakeRuntime();
    const runtimeB = fakeRuntime();

    const bound = bindCloudGithubTokenToRuntime(runtimeA, {
      accessToken: "gho_agent_a",
      githubUsername: "octo-a",
    });

    expect(bound).toBe(true);
    expect(runtimeA.getSetting("GITHUB_TOKEN")).toBe("gho_agent_a");
    // Co-tenant isolation: agent B resolves nothing, and the process env
    // stays untouched for spawned subprocesses of other agents.
    expect(runtimeB.getSetting("GITHUB_TOKEN")).toBeNull();
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("never overwrites an already-resolved token on the runtime", () => {
    const runtime = fakeRuntime({ GITHUB_TOKEN: "gho_existing" });
    const bound = bindCloudGithubTokenToRuntime(runtime, {
      accessToken: "gho_late_fetch",
      githubUsername: "octo-late",
    });
    expect(bound).toBe(false);
    expect(runtime.getSetting("GITHUB_TOKEN")).toBe("gho_existing");
  });

  it("is a no-op for null or empty fetch results", () => {
    const runtime = fakeRuntime();
    expect(bindCloudGithubTokenToRuntime(runtime, null)).toBe(false);
    expect(
      bindCloudGithubTokenToRuntime(runtime, {
        accessToken: "",
        githubUsername: null,
      }),
    ).toBe(false);
    expect(runtime.getSetting("GITHUB_TOKEN")).toBeNull();
  });

  it("keeps two agents' cloud tokens fully independent", () => {
    const runtimeA = fakeRuntime();
    const runtimeB = fakeRuntime();

    bindCloudGithubTokenToRuntime(runtimeA, {
      accessToken: "gho_agent_a",
      githubUsername: "octo-a",
    });
    bindCloudGithubTokenToRuntime(runtimeB, {
      accessToken: "gho_agent_b",
      githubUsername: "octo-b",
    });

    // The later bind must not become the earlier agent's identity — the
    // last-writer-wins overwrite was the core #15904 defect.
    expect(runtimeA.getSetting("GITHUB_TOKEN")).toBe("gho_agent_a");
    expect(runtimeB.getSetting("GITHUB_TOKEN")).toBe("gho_agent_b");
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });
});
