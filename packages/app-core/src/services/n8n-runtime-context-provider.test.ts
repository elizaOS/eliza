import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ConnectorConfigLike,
  N8N_RUNTIME_CONTEXT_PROVIDER_SERVICE_TYPE,
  startMiladyN8nRuntimeContextProvider,
} from "./n8n-runtime-context-provider";

const USER_ID = "00000000-0000-0000-0000-000000000001";

function makeRuntime(): AgentRuntime {
  const services = new Map<string, unknown[]>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    services,
    logger,
  } as unknown as AgentRuntime;
}

function makeConfig(overrides: ConnectorConfigLike = {}): ConnectorConfigLike {
  return {
    connectors: {
      ...(overrides.connectors ?? {}),
    },
  };
}

/**
 * Plugin's `NodeDefinition.credentials` shape, minimally typed for tests.
 */
const DISCORD_NODE = {
  name: "n8n-nodes-base.discord",
  displayName: "Discord",
  credentials: [{ name: "discordApi", required: true }],
} as const;

const GMAIL_NODE = {
  name: "n8n-nodes-base.gmail",
  displayName: "Gmail",
  credentials: [{ name: "gmailOAuth2", required: true }],
} as const;

describe("startMiladyN8nRuntimeContextProvider", () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    runtime = makeRuntime();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers itself under n8n_runtime_context_provider on construction", () => {
    startMiladyN8nRuntimeContextProvider(runtime, {
      getConfig: () => makeConfig(),
    });
    const instances = runtime.services.get(
      N8N_RUNTIME_CONTEXT_PROVIDER_SERVICE_TYPE as never,
    );
    expect(instances).toBeDefined();
    expect(instances?.length).toBe(1);
    expect(
      typeof (instances?.[0] as { getRuntimeContext: unknown })
        .getRuntimeContext,
    ).toBe("function");
  });

  it("emits empty facts when no connector config and no credProvider injected — but still lists architecturally supported cred types", async () => {
    // Without a credProvider, the context provider can't filter by what's
    // actually resolvable, so it falls back to MILADY_SUPPORTED_CRED_TYPES.
    // That's the right call: the LLM should still attach the credentials
    // block — failure to resolve at deploy time surfaces a clear `needs_auth`
    // error, while omitting the block silently is what we're trying to fix.
    const handle = startMiladyN8nRuntimeContextProvider(runtime, {
      getConfig: () => makeConfig(),
    });
    const ctx = await handle.service.getRuntimeContext({
      userId: USER_ID,
      relevantNodes: [DISCORD_NODE],
      relevantCredTypes: ["discordApi"],
    });
    expect(ctx.facts).toEqual([]);
    expect(ctx.supportedCredentials.map((c) => c.credType)).toEqual([
      "discordApi",
    ]);
  });

  it("emits one fact per Discord guild with channels enumerated", async () => {
    const config = makeConfig({
      connectors: { discord: { token: "discord-bot-token" } },
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.endsWith("/users/@me/guilds")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: "guild1", name: "2PM" },
            { id: "guild2", name: "TestServer" },
          ],
        } as unknown as Response;
      }
      if (typeof url === "string" && url.includes("/guilds/guild1/channels")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: "chan-general", name: "general", type: 0 },
            { id: "chan-voice", name: "voice", type: 2 },
          ],
        } as unknown as Response;
      }
      if (typeof url === "string" && url.includes("/guilds/guild2/channels")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: "chan-other", name: "other-text", type: 0 },
          ],
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const handle = startMiladyN8nRuntimeContextProvider(runtime, {
      getConfig: () => config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ctx = await handle.service.getRuntimeContext({
      userId: USER_ID,
      relevantNodes: [DISCORD_NODE],
      relevantCredTypes: ["discordApi"],
    });
    expect(ctx.facts).toHaveLength(2);
    expect(ctx.facts[0]).toContain('Discord guild "2PM"');
    expect(ctx.facts[0]).toContain("guild1");
    expect(ctx.facts[0]).toContain("#general (chan-general)");
    expect(ctx.facts[0]).not.toContain("voice"); // type !== 0 filtered
    expect(ctx.facts[1]).toContain('Discord guild "TestServer"');
    expect(ctx.facts[1]).toContain("#other-text (chan-other)");
  });

  it("emits gmail email fact when configured and a gmail node is in scope", async () => {
    const config = makeConfig({
      connectors: { gmail: { email: "user@example.com" } },
    });
    const handle = startMiladyN8nRuntimeContextProvider(runtime, {
      getConfig: () => config,
    });
    const ctx = await handle.service.getRuntimeContext({
      userId: USER_ID,
      relevantNodes: [GMAIL_NODE],
      relevantCredTypes: ["gmailOAuth2"],
    });
    expect(ctx.facts).toEqual(["Connected Gmail account: user@example.com."]);
  });

  it("filters supportedCredentials by what the cred provider can actually resolve", async () => {
    const credProvider = {
      resolve: vi.fn(async (_userId: string, credType: string) => {
        if (credType === "discordApi") {
          return {
            status: "credential_data" as const,
            data: { botToken: "x" },
          };
        }
        return {
          status: "needs_auth" as const,
          authUrl: "milady://settings/connectors/gmail",
        };
      }),
    };
    const handle = startMiladyN8nRuntimeContextProvider(runtime, {
      getConfig: () => makeConfig(),
      credProvider,
    });
    const ctx = await handle.service.getRuntimeContext({
      userId: USER_ID,
      relevantNodes: [DISCORD_NODE, GMAIL_NODE],
      relevantCredTypes: ["discordApi", "gmailOAuth2"],
    });
    expect(ctx.supportedCredentials.map((c) => c.credType)).toEqual([
      "discordApi",
    ]);
    expect(credProvider.resolve).toHaveBeenCalledWith(USER_ID, "discordApi");
    expect(credProvider.resolve).toHaveBeenCalledWith(USER_ID, "gmailOAuth2");
  });

  it("swallows network failures and returns empty facts", async () => {
    const config = makeConfig({
      connectors: { discord: { token: "discord-bot-token" } },
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const handle = startMiladyN8nRuntimeContextProvider(runtime, {
      getConfig: () => config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ctx = await handle.service.getRuntimeContext({
      userId: USER_ID,
      relevantNodes: [DISCORD_NODE],
      relevantCredTypes: ["discordApi"],
    });
    expect(ctx.facts).toEqual([]);
  });

  it("does not query Discord REST when no Discord node is in scope", async () => {
    const config = makeConfig({
      connectors: { discord: { token: "discord-bot-token" } },
    });
    const fetchImpl = vi.fn();
    const handle = startMiladyN8nRuntimeContextProvider(runtime, {
      getConfig: () => config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ctx = await handle.service.getRuntimeContext({
      userId: USER_ID,
      relevantNodes: [GMAIL_NODE],
      relevantCredTypes: ["gmailOAuth2"],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ctx.facts).toEqual([]);
  });

  it("caches Discord REST responses across consecutive calls", async () => {
    const config = makeConfig({
      connectors: { discord: { token: "tok" } },
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.endsWith("/users/@me/guilds")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: "g", name: "G" }],
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => [],
      } as unknown as Response;
    });
    const handle = startMiladyN8nRuntimeContextProvider(runtime, {
      getConfig: () => config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await handle.service.getRuntimeContext({
      userId: USER_ID,
      relevantNodes: [DISCORD_NODE],
      relevantCredTypes: ["discordApi"],
    });
    const firstCallCount = fetchImpl.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    await handle.service.getRuntimeContext({
      userId: USER_ID,
      relevantNodes: [DISCORD_NODE],
      relevantCredTypes: ["discordApi"],
    });
    expect(fetchImpl.mock.calls.length).toBe(firstCallCount);
  });
});
