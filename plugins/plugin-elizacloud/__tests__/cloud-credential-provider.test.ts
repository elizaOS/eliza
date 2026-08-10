/**
 * Unit tests for CloudCredentialProvider.
 *
 * The provider reads cloud connection state via `runtime.getService("CLOUD_AUTH")`
 * and uses generic OAuth plus agent-scoped connector bindings through the
 * resulting client. We mock both layers without booting a real cloud.
 */

import { describe, expect, it } from "vitest";
import { credTypeToConnector, supportedCredTypes } from "../src/lib/credential-type-map";
import { CloudCredentialProvider } from "../src/services/cloud-credential-provider";

interface MockClientCalls {
  gets: string[];
  posts: Array<{ path: string; body: unknown }>;
}

function makeRuntime(
  opts: { client?: { get?: unknown; post?: unknown } | null; cloudAuth?: object | null } = {}
): {
  runtime: { agentId: string; getService: (name: string) => unknown };
  calls: MockClientCalls;
} {
  const calls: MockClientCalls = { gets: [], posts: [] };
  const cloudAuth = opts.cloudAuth ?? {
    getClient: () => opts.client ?? null,
  };
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000123",
    getService: (name: string) => (name === "CLOUD_AUTH" ? cloudAuth : null),
  };
  return { runtime, calls };
}

function instantiate(runtime: {
  agentId?: string;
  getService: (name: string) => unknown;
}): CloudCredentialProvider {
  // Bypass the elizaOS Service constructor signature gymnastics — the
  // provider only ever touches `this.runtime.getService`, which we mock.
  return new CloudCredentialProvider(runtime as never);
}

describe("CloudCredentialProvider — credential type map", () => {
  it("maps the documented Google credential types to the google connector", () => {
    expect(credTypeToConnector.get("gmailOAuth2")?.connector).toBe("google");
    expect(credTypeToConnector.get("gmailOAuth2Api")?.connector).toBe("google");
    expect(credTypeToConnector.get("googleCalendarOAuth2Api")?.connector).toBe("google");
  });

  it("declares the expected supported set", () => {
    for (const t of [
      "gmailOAuth2",
      "gmailOAuth2Api",
      "googleCalendarOAuth2Api",
      "googleSheetsOAuth2Api",
      "githubOAuth2Api",
      "githubApi",
      "discordApi",
      "discordBotApi",
    ]) {
      expect(supportedCredTypes.has(t)).toBe(true);
    }
  });
});

describe("CloudCredentialProvider.checkCredentialTypes", () => {
  it("partitions known vs unknown credential types", () => {
    const { runtime } = makeRuntime();
    const provider = instantiate(runtime);
    const result = provider.checkCredentialTypes([
      "gmailOAuth2",
      "slackOAuth2Api", // not in cloud map
      "githubApi",
      "weirdCustomCred",
    ]);
    expect(result.supported.sort()).toEqual(["githubApi", "gmailOAuth2"]);
    expect(result.unsupported.sort()).toEqual(["slackOAuth2Api", "weirdCustomCred"]);
  });

  it("returns empty arrays for an empty input", () => {
    const { runtime } = makeRuntime();
    const provider = instantiate(runtime);
    expect(provider.checkCredentialTypes([])).toEqual({ supported: [], unsupported: [] });
  });
});

describe("CloudCredentialProvider.resolve", () => {
  it("returns null for an unmapped credType without touching the cloud", async () => {
    let called = false;
    const { runtime } = makeRuntime({
      client: {
        get: () => {
          called = true;
          return Promise.resolve({});
        },
      },
    });
    const provider = instantiate(runtime);
    const result = await provider.resolve("user-1", "snowflakeApi");
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when CLOUD_AUTH service is not registered", async () => {
    const runtime = { getService: () => null };
    const provider = instantiate(runtime);
    const result = await provider.resolve("user-1", "gmailOAuth2");
    expect(result).toBeNull();
  });

  it("returns null when the cloud client is missing", async () => {
    const { runtime } = makeRuntime({
      cloudAuth: { getClient: () => null },
    });
    const provider = instantiate(runtime);
    const result = await provider.resolve("user-1", "gmailOAuth2");
    expect(result).toBeNull();
  });

  it("returns needs_auth with the cloud-issued URL when the connector is not connected", async () => {
    const calls: { gets: string[]; posts: Array<{ path: string; body: unknown }> } = {
      gets: [],
      posts: [],
    };
    const client = {
      get: (path: string) => {
        calls.gets.push(path);
        return Promise.resolve([]);
      },
      post: (path: string, body: unknown) => {
        calls.posts.push({ path, body });
        return Promise.resolve({ authUrl: "https://elizacloud.ai/oauth/google?state=abc" });
      },
    };
    const { runtime } = makeRuntime({ client });
    const provider = instantiate(runtime);
    const result = await provider.resolve("user-1", "gmailOAuth2");
    expect(result).toEqual({
      status: "needs_auth",
      authUrl: "https://elizacloud.ai/oauth/google?state=abc",
    });
    expect(calls.gets).toEqual(["/eliza/agents/00000000-0000-4000-8000-000000000123/connectors"]);
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]).toEqual({
      path: "/oauth/google/initiate",
      body: expect.objectContaining({
        connectionRole: "owner",
        scopes: expect.arrayContaining(["https://www.googleapis.com/auth/gmail.readonly"]),
        agentBinding: {
          agentId: "00000000-0000-4000-8000-000000000123",
          role: "OWNER",
          selectedProducts: ["gmail"],
          isDefault: true,
        },
      }),
    });
  });

  it("initiates OAuth when the agent has Google bound without the required product", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = {
      get: () =>
        Promise.resolve([
          { provider: "google", status: "connected", selectedProducts: ["calendar"] },
        ]),
      post: (path: string, body: unknown) => {
        posts.push({ path, body });
        return Promise.resolve({ authUrl: "https://elizacloud.ai/oauth/google?state=next" });
      },
    };
    const { runtime } = makeRuntime({ client });
    const provider = instantiate(runtime);
    const result = await provider.resolve("user-1", "gmailOAuth2");
    expect(result).toEqual({
      status: "needs_auth",
      authUrl: "https://elizacloud.ai/oauth/google?state=next",
    });
    expect(posts[0]?.path).toBe("/oauth/google/initiate");
  });

  it("returns null for an active product binding rather than exporting or reauthorizing a token", async () => {
    let posted = false;
    const client = {
      get: () =>
        Promise.resolve([{ provider: "google", status: "connected", selectedProducts: ["gmail"] }]),
      post: () => {
        posted = true;
        return Promise.resolve({ authUrl: "https://elizacloud.ai/oauth/google?reauth=stale" });
      },
    };
    const { runtime } = makeRuntime({ client });
    const provider = instantiate(runtime);
    await expect(provider.resolve("user-1", "gmailOAuth2")).resolves.toBeNull();
    expect(posted).toBe(false);
  });

  it("issues a connect/initiate without capabilities when the mapping has none (e.g. github)", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = {
      get: () => Promise.resolve({ connected: false }),
      post: (path: string, body: unknown) => {
        posts.push({ path, body });
        return Promise.resolve({ authUrl: "https://elizacloud.ai/oauth/github?state=xyz" });
      },
    };
    const { runtime } = makeRuntime({ client });
    const provider = instantiate(runtime);
    await provider.resolve("user-1", "githubOAuth2Api");
    expect(posts).toEqual([{ path: "/eliza/github/connect/initiate", body: {} }]);
  });

  it("returns null when cloud refuses to issue an authUrl", async () => {
    const client = {
      get: () => Promise.resolve({ connected: false }),
      post: () => Promise.resolve({}),
    };
    const { runtime } = makeRuntime({ client });
    const provider = instantiate(runtime);
    const result = await provider.resolve("user-1", "gmailOAuth2");
    expect(result).toBeNull();
  });
});

describe("CloudCredentialProvider — service slot", () => {
  it("claims the canonical workflow_credential_provider service-type", () => {
    expect(CloudCredentialProvider.serviceType).toBe("workflow_credential_provider");
  });
});
