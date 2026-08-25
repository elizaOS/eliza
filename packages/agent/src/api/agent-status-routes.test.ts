/**
 * Covers handleAgentStatusRoutes: GET /api/agent/self-status (wallet
 * composition, plugin classification, model/provider fallback, awareness
 * registry summary) and the ERC-8004 registry routes, which currently
 * degrade to unconfigured / 503 because getRegistryServiceIfAvailable
 * always returns null. Deterministic: injects deps plus json/error
 * responders and a fake runtime; no live model or chain.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentStatusRouteContext,
  type AgentStatusRouteDeps,
  type AgentStatusRouteState,
  handleAgentStatusRoutes,
} from "./agent-status-routes";

type Capability = ReturnType<
  AgentStatusRouteDeps["resolveWalletCapabilityStatus"]
>;

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  // Declared as Capability so the base is checked in full, then merged and
  // re-asserted: spreading Partial<Capability> widens every field it mentions to
  // `T | undefined`, which TS rejects against the required shape (TS2322).
  // vitest does not typecheck, so a green suite does not catch this.
  const base: Capability = {
    walletSource: "local",
    hasWallet: true,
    hasEvm: true,
    evmAddress: "0x1234567890abcdef1234",
    localSignerAvailable: true,
    rpcReady: true,
    pluginEvmLoaded: true,
    pluginEvmRequired: false,
    executionReady: true,
    executionBlockedReason: null,
    automationMode: "full",
    walletNetwork: "mainnet",
    solanaAddress: null,
    evmSigningCapability: "local",
    evmSigningReason: "local signer available",
  };
  return { ...base, ...overrides } as Capability;
}

function makeConfig(overrides: Partial<ElizaConfig> = {}): ElizaConfig {
  return {
    registry: {
      registryAddress: "0xregistry",
      collectionAddress: "0xcollection",
    },
    ...overrides,
  } as ElizaConfig;
}

function makeState(
  overrides: Partial<AgentStatusRouteState> = {},
): AgentStatusRouteState {
  return {
    config: makeConfig(),
    runtime: null,
    agentState: "running",
    agentName: "Eliza",
    ...overrides,
  };
}

function fakeRuntime(plugins: Array<{ name?: unknown }> = []): AgentRuntime {
  return { plugins, character: { name: "Eliza" } } as unknown as AgentRuntime;
}

function makeDeps(
  overrides: Partial<AgentStatusRouteDeps> = {},
): AgentStatusRouteDeps {
  return {
    getWalletAddresses: () => ({
      evmAddress: "0x1234567890abcdef1234",
      solanaAddress: "SoLanaAddressLongEnough",
    }),
    resolveWalletCapabilityStatus: () => makeCapability(),
    resolveWalletRpcReadiness: () => ({ managedBscRpcReady: true }),
    resolveTradePermissionMode: () => "agent-auto",
    canUseLocalTradeExecution: (_mode, isAgentRequest, _log?, opts?) => {
      if (isAgentRequest) {
        return opts?.consumeAgentQuota === false;
      }
      return true;
    },
    detectRuntimeModel: () => undefined,
    resolveProviderFromModel: (model) =>
      model.startsWith("gpt") ? "openai" : "other",
    getAwarenessRegistry: () => null,
    RegistryService: {
      defaultCapabilitiesHash: () => "0xdead",
    },
    ...overrides,
  };
}

function makeCtx(
  method: string,
  pathname: string,
  state: AgentStatusRouteState = makeState(),
  deps: AgentStatusRouteDeps = makeDeps(),
) {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn() as AgentStatusRouteContext["readJsonBody"];
  const ctx: AgentStatusRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname,
    url: new URL(`http://127.0.0.1${pathname}`),
    state,
    json,
    error,
    readJsonBody,
    deps,
  };
  return {
    ctx,
    state,
    json,
    error,
    readJsonBody,
    deps,
  };
}

describe("handleAgentStatusRoutes — dispatch", () => {
  it("returns false for an unrelated path", async () => {
    const { ctx, json, error } = makeCtx("GET", "/api/agent/start");

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(false);

    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("returns false for POST /api/agent/self-status (wrong method)", async () => {
    const { ctx, json, error } = makeCtx("POST", "/api/agent/self-status");

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(false);

    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("returns false for a /api/registry prefix that matches no route", async () => {
    const { ctx, json, error } = makeCtx("GET", "/api/registry/unknown");

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(false);

    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("handleAgentStatusRoutes — GET /api/agent/self-status", () => {
  it("composes wallet, plugins, and capabilities with no runtime", async () => {
    const detectRuntimeModel = vi.fn(() => undefined);
    const getAwarenessRegistry = vi.fn(() => null);
    const { ctx, json, error } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState({ runtime: null, model: undefined, shellEnabled: undefined }),
      makeDeps({ detectRuntimeModel, getAwarenessRegistry }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.generatedAt as string))).toBe(false);
    expect(body).toEqual(
      expect.objectContaining({
        state: "running",
        agentName: "Eliza",
        model: null,
        provider: null,
        automationMode: "full",
        tradePermissionMode: "agent-auto",
        shellEnabled: true,
        wallet: expect.objectContaining({
          walletSource: "local",
          hasWallet: true,
          hasEvm: true,
          hasSolana: true,
          evmAddress: "0x1234567890abcdef1234",
          evmAddressShort: "0x1234...1234",
          solanaAddress: "SoLanaAddressLongEnough",
          solanaAddressShort: "SoLa...ough",
          localSignerAvailable: true,
          managedBscRpcReady: true,
        }),
        plugins: {
          totalActive: 0,
          active: [],
          aiProviders: [],
          connectors: [],
        },
        capabilities: {
          canTrade: true,
          canLocalTrade: true,
          canAutoTrade: true,
          canUseBrowser: false,
          canUseComputer: false,
          canRunTerminal: true,
          canInstallPlugins: true,
          canConfigurePlugins: true,
          canConfigureConnectors: true,
        },
      }),
    );
    expect(body).not.toHaveProperty("registrySummary");
    expect(detectRuntimeModel).toHaveBeenCalledTimes(1);
    expect(getAwarenessRegistry).toHaveBeenCalledTimes(1);
  });

  it("prefers state.model over detectRuntimeModel and resolves a provider", async () => {
    const detectRuntimeModel = vi.fn(() => "should-not-win");
    const resolveProviderFromModel = vi.fn((model: string) =>
      model === "gpt-4.1" ? "openai" : null,
    );
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState({ model: "gpt-4.1" }),
      makeDeps({ detectRuntimeModel, resolveProviderFromModel }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as Record<string, unknown>;
    expect(body.model).toBe("gpt-4.1");
    expect(body.provider).toBe("openai");
    expect(detectRuntimeModel).not.toHaveBeenCalled();
    expect(resolveProviderFromModel).toHaveBeenCalledWith("gpt-4.1");
  });

  it("falls back to detectRuntimeModel when state.model is unset", async () => {
    const detectRuntimeModel = vi.fn(() => "claude-sonnet");
    const resolveProviderFromModel = vi.fn(() => "anthropic");
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState({ model: undefined, runtime: fakeRuntime() }),
      makeDeps({ detectRuntimeModel, resolveProviderFromModel }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet");
    expect(body.provider).toBe("anthropic");
    expect(detectRuntimeModel).toHaveBeenCalledTimes(1);
  });

  it("leaves short wallet addresses unshortened and null solana as null", async () => {
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState(),
      makeDeps({
        getWalletAddresses: () => ({
          evmAddress: "0xshort",
          solanaAddress: null,
        }),
        resolveWalletCapabilityStatus: () =>
          makeCapability({ evmAddress: "0xshort" }),
      }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as {
      wallet: Record<string, unknown>;
    };
    expect(body.wallet.evmAddress).toBe("0xshort");
    expect(body.wallet.evmAddressShort).toBe("0xshort");
    expect(body.wallet.hasSolana).toBe(false);
    expect(body.wallet.solanaAddress).toBeNull();
    expect(body.wallet.solanaAddressShort).toBeNull();
  });

  it("classifies plugins and skips blank / non-string names", async () => {
    const runtime = fakeRuntime([
      { name: "  " },
      { name: 12 },
      { name: "OpenAI" },
      { name: "anthropic-proxy" },
      { name: "Groq" },
      { name: "gemini" },
      { name: "openrouter" },
      { name: "deepseek" },
      { name: "ollama" },
      { name: "discord" },
      { name: "telegram" },
      { name: "twitter" },
      { name: "slack" },
      { name: "browser" },
      { name: "browserbase" },
      { name: "chrome-extension" },
      { name: "computeruse" },
      { name: "computer-use" },
      { name: "@elizaos/plugin-computeruse" },
      { name: "@elizaos/plugin-computer-use" },
      { name: "notes" },
      { name: "my-browser" },
    ]);
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState({ runtime }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as {
      plugins: {
        totalActive: number;
        active: string[];
        aiProviders: string[];
        connectors: string[];
      };
      capabilities: {
        canUseBrowser: boolean;
        canUseComputer: boolean;
      };
    };
    expect(body.plugins.active).not.toContain("  ");
    expect(body.plugins.active).toEqual(
      expect.arrayContaining([
        "OpenAI",
        "notes",
        "my-browser",
        "@elizaos/plugin-computer-use",
      ]),
    );
    expect(body.plugins.totalActive).toBe(body.plugins.active.length);
    expect(body.plugins.aiProviders).toEqual([
      "OpenAI",
      "anthropic-proxy",
      "Groq",
      "gemini",
      "openrouter",
      "deepseek",
      "ollama",
    ]);
    expect(body.plugins.connectors).toEqual([
      "discord",
      "telegram",
      "twitter",
      "slack",
    ]);
    expect(body.capabilities.canUseBrowser).toBe(true);
    expect(body.capabilities.canUseComputer).toBe(true);
  });

  it("does not treat a non-array plugins field as active plugins", async () => {
    const runtime = {
      plugins: { name: "openai" },
      character: { name: "Eliza" },
    } as unknown as AgentRuntime;
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState({ runtime }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as {
      plugins: { totalActive: number; active: string[] };
      capabilities: { canUseBrowser: boolean; canUseComputer: boolean };
    };
    expect(body.plugins).toEqual({
      totalActive: 0,
      active: [],
      aiProviders: [],
      connectors: [],
    });
    expect(body.capabilities.canUseBrowser).toBe(false);
    expect(body.capabilities.canUseComputer).toBe(false);
  });

  it("disables trade when evmAddress is missing even if RPC is ready", async () => {
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState(),
      makeDeps({
        resolveWalletCapabilityStatus: () =>
          makeCapability({ evmAddress: null, localSignerAvailable: true }),
        resolveWalletRpcReadiness: () => ({ managedBscRpcReady: true }),
        canUseLocalTradeExecution: () => true,
      }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as {
      capabilities: Record<string, unknown>;
    };
    expect(body.capabilities.canTrade).toBe(false);
    expect(body.capabilities.canLocalTrade).toBe(false);
    expect(body.capabilities.canAutoTrade).toBe(false);
  });

  it("disables trade when BSC RPC is not ready even with an EVM address", async () => {
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState(),
      makeDeps({
        resolveWalletRpcReadiness: () => ({ managedBscRpcReady: false }),
        canUseLocalTradeExecution: () => true,
      }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as {
      capabilities: Record<string, unknown>;
      wallet: { managedBscRpcReady: boolean };
    };
    expect(body.wallet.managedBscRpcReady).toBe(false);
    expect(body.capabilities.canTrade).toBe(false);
    expect(body.capabilities.canLocalTrade).toBe(false);
    expect(body.capabilities.canAutoTrade).toBe(false);
  });

  it("requires a local signer for local/auto trade even when canTrade is true", async () => {
    const canUseLocalTradeExecution = vi.fn(() => true);
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState(),
      makeDeps({
        resolveWalletCapabilityStatus: () =>
          makeCapability({ localSignerAvailable: false }),
        canUseLocalTradeExecution,
      }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as {
      capabilities: Record<string, unknown>;
    };
    expect(body.capabilities.canTrade).toBe(true);
    expect(body.capabilities.canLocalTrade).toBe(false);
    expect(body.capabilities.canAutoTrade).toBe(false);
    expect(canUseLocalTradeExecution).toHaveBeenCalledWith("agent-auto", false);
    expect(canUseLocalTradeExecution).toHaveBeenCalledWith(
      "agent-auto",
      true,
      undefined,
      { consumeAgentQuota: false },
    );
  });

  it("gates local vs auto trade independently through canUseLocalTradeExecution", async () => {
    const canUseLocalTradeExecution = vi.fn(
      (
        _mode: string,
        isAgentRequest: boolean,
        _log?: (message: string) => void,
        opts?: { consumeAgentQuota?: boolean },
      ) => {
        if (isAgentRequest) return false;
        expect(opts).toBeUndefined();
        return true;
      },
    );
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState(),
      makeDeps({ canUseLocalTradeExecution }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as {
      capabilities: Record<string, unknown>;
    };
    expect(body.capabilities.canTrade).toBe(true);
    expect(body.capabilities.canLocalTrade).toBe(true);
    expect(body.capabilities.canAutoTrade).toBe(false);
  });

  it("treats shellEnabled false as terminal-disabled", async () => {
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState({ shellEnabled: false }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    const body = json.mock.calls[0][1] as {
      shellEnabled: boolean;
      capabilities: { canRunTerminal: boolean };
    };
    expect(body.shellEnabled).toBe(false);
    expect(body.capabilities.canRunTerminal).toBe(false);
  });

  it("includes registrySummary when awareness composeSummary succeeds", async () => {
    const composeSummary = vi.fn(async () => "aware");
    const runtime = fakeRuntime();
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState({ runtime }),
      makeDeps({
        getAwarenessRegistry: () => ({ composeSummary }),
      }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(composeSummary).toHaveBeenCalledWith(runtime);
    const body = json.mock.calls[0][1] as { registrySummary: string };
    expect(body.registrySummary).toBe("aware");
  });

  it("omits registrySummary when composeSummary throws (non-fatal)", async () => {
    const composeSummary = vi.fn(async () => {
      throw new Error("awareness down");
    });
    const { ctx, json, error } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState({ runtime: fakeRuntime() }),
      makeDeps({
        getAwarenessRegistry: () => ({ composeSummary }),
      }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    const body = json.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("registrySummary");
  });

  it("does not compose an awareness summary without a runtime", async () => {
    const composeSummary = vi.fn(async () => "should-not-run");
    const { ctx, json } = makeCtx(
      "GET",
      "/api/agent/self-status",
      makeState({ runtime: null }),
      makeDeps({
        getAwarenessRegistry: () => ({ composeSummary }),
      }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(composeSummary).not.toHaveBeenCalled();
    const body = json.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("registrySummary");
  });
});

describe("handleAgentStatusRoutes — ERC-8004 registry (service unavailable)", () => {
  it("GET /api/registry/status reports unconfigured zeros", async () => {
    const { ctx, json, error } = makeCtx("GET", "/api/registry/status");

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, {
      registered: false,
      tokenId: 0,
      agentName: "",
      agentEndpoint: "",
      capabilitiesHash: "",
      isActive: false,
      tokenURI: "",
      walletAddress: "",
      totalAgents: 0,
      configured: false,
    });
  });

  it("POST /api/registry/register 503s without reading a body", async () => {
    const { ctx, json, error, readJsonBody } = makeCtx(
      "POST",
      "/api/registry/register",
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(readJsonBody).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Registry service not configured. Set registry config and EVM_PRIVATE_KEY.",
      503,
    );
  });

  it("POST /api/registry/update-uri 503s without reading a body", async () => {
    const { ctx, json, error, readJsonBody } = makeCtx(
      "POST",
      "/api/registry/update-uri",
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(readJsonBody).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Registry service not configured.",
      503,
    );
  });

  it("POST /api/registry/sync 503s without reading a body", async () => {
    const { ctx, json, error, readJsonBody } = makeCtx(
      "POST",
      "/api/registry/sync",
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(readJsonBody).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Registry service not configured.",
      503,
    );
  });

  it("GET /api/registry/config uses chainId 1 and the etherscan explorer", async () => {
    const { ctx, json } = makeCtx(
      "GET",
      "/api/registry/config",
      makeState({
        config: makeConfig({
          registry: {
            registryAddress: "0xreg",
            collectionAddress: "0xcol",
          },
        }),
      }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(ctx.res, {
      configured: false,
      chainId: 1,
      registryAddress: "0xreg",
      collectionAddress: "0xcol",
      explorerUrl: "https://etherscan.io",
    });
  });

  it("GET /api/registry/config nulls missing registry addresses", async () => {
    const { ctx, json } = makeCtx(
      "GET",
      "/api/registry/config",
      makeState({ config: {} as ElizaConfig }),
    );

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(ctx.res, {
      configured: false,
      chainId: 1,
      registryAddress: null,
      collectionAddress: null,
      explorerUrl: "https://etherscan.io",
    });
  });
});
