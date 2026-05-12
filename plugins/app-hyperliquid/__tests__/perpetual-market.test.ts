import type {
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hyperliquidActions,
  PERPETUAL_MARKET_SERVICE_TYPE,
  PerpetualMarketService,
  perpetualMarketAction,
} from "../src/actions/perpetual-market";
import { hyperliquidPlugin } from "../src/plugin";

interface FetchMock {
  fn: ReturnType<typeof vi.fn>;
  byPath: Map<string, unknown>;
}

function installFetchMock(byPath: Record<string, unknown>): FetchMock {
  const map = new Map(Object.entries(byPath));
  const fn = vi.fn(async (url: string) => {
    for (const [suffix, body] of map.entries()) {
      if (url.endsWith(suffix)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: `unmocked ${url}` }), {
      status: 500,
    });
  });
  // @ts-expect-error override global fetch in tests
  globalThis.fetch = fn;
  return { fn, byPath: map };
}

function makeRuntime(service: PerpetualMarketService | null): IAgentRuntime {
  return {
    getService: (type: string) =>
      type === PERPETUAL_MARKET_SERVICE_TYPE ? service : null,
  } as unknown as IAgentRuntime;
}

function makeMessage(text = "show me hyperliquid markets"): Memory {
  return {
    content: { text },
  } as unknown as Memory;
}

function makeState(selected?: string[]): State {
  return {
    values: {
      selectedContexts: selected ?? [],
      recentMessages: "",
    },
    data: {},
    text: "",
  } as unknown as State;
}

describe("perpetualMarketAction shape", () => {
  it("uses PERPETUAL_MARKET as the action name", () => {
    expect(perpetualMarketAction.name).toBe("PERPETUAL_MARKET");
  });

  it("declares the required similes including HYPERLIQUID, PERP_MARKET, HYPERLIQUID_READ", () => {
    expect(perpetualMarketAction.similes).toContain("HYPERLIQUID");
    expect(perpetualMarketAction.similes).toContain("PERP_MARKET");
    expect(perpetualMarketAction.similes).toContain("HYPERLIQUID_READ");
  });

  it("declares action discriminator with read and place_order, plus subaction alias", () => {
    const params = perpetualMarketAction.parameters ?? [];
    const actionParam = params.find((p) => p.name === "action");
    const subactionParam = params.find((p) => p.name === "subaction");
    expect(actionParam, "action parameter missing").toBeDefined();
    expect(subactionParam, "subaction alias parameter missing").toBeDefined();
    const actionEnum = (actionParam?.schema as { enum?: string[] } | undefined)
      ?.enum;
    const subactionEnum = (
      subactionParam?.schema as { enum?: string[] } | undefined
    )?.enum;
    expect(actionEnum).toEqual(expect.arrayContaining(["read", "place_order"]));
    expect(subactionEnum).toEqual(
      expect.arrayContaining(["read", "place_order", "place-order"]),
    );
  });

  it("declares finance/crypto/trading contexts and a context gate", () => {
    expect(perpetualMarketAction.contexts).toEqual(
      expect.arrayContaining(["finance", "crypto", "trading"]),
    );
    expect(
      (perpetualMarketAction.contextGate as { anyOf?: string[] } | undefined)
        ?.anyOf,
    ).toEqual(
      expect.arrayContaining(["finance", "crypto", "trading", "payments"]),
    );
  });
});

describe("hyperliquidPlugin wiring", () => {
  it("exposes PERPETUAL_MARKET as a registered action", () => {
    expect((hyperliquidPlugin.actions ?? []).map((a) => a.name)).toContain(
      "PERPETUAL_MARKET",
    );
  });

  it("registers PerpetualMarketService", () => {
    expect(hyperliquidPlugin.services ?? []).toContain(PerpetualMarketService);
  });

  it("exports the action via hyperliquidActions[]", () => {
    expect(hyperliquidActions.map((a) => a.name)).toEqual(["PERPETUAL_MARKET"]);
  });
});

describe("perpetualMarketAction validation gating", () => {
  it("validates when selectedContexts includes a hyperliquid context", async () => {
    const runtime = makeRuntime(null);
    const result = await perpetualMarketAction.validate?.(
      runtime,
      makeMessage("some unrelated text"),
      makeState(["finance"]),
    );
    expect(result).toBe(true);
  });

  it("validates when message text contains a hyperliquid keyword", async () => {
    const runtime = makeRuntime(null);
    const result = await perpetualMarketAction.validate?.(
      runtime,
      makeMessage("what are the funding rates on hyperliquid"),
      makeState([]),
    );
    expect(result).toBe(true);
  });

  it("rejects when neither context nor keyword intent is present", async () => {
    const runtime = makeRuntime(null);
    const result = await perpetualMarketAction.validate?.(
      runtime,
      makeMessage("hello world"),
      makeState([]),
    );
    expect(result).toBe(false);
  });
});

describe("perpetualMarketAction handler", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function startService(): Promise<PerpetualMarketService> {
    const runtime = makeRuntime(null);
    return await PerpetualMarketService.start(runtime);
  }

  async function invoke(
    options: Record<string, unknown>,
    service: PerpetualMarketService,
  ) {
    const runtime = makeRuntime(service);
    const callback = vi.fn() as unknown as HandlerCallback;
    const result = await perpetualMarketAction.handler!(
      runtime,
      makeMessage(),
      makeState(["finance"]),
      options,
      callback,
    );
    return { result, callback };
  }

  it("fails when no action/subaction is provided", async () => {
    const service = await startService();
    const { result, callback } = await invoke({}, service);
    expect(result.success).toBe(false);
    expect(result.error).toBe("missing_or_invalid_op");
    expect(callback).toHaveBeenCalled();
  });

  it("accepts subaction alias and routes to read with required kind", async () => {
    installFetchMock({});
    const service = await startService();
    const { result } = await invoke(
      { subaction: "read" }, // no kind provided
      service,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("missing_or_invalid_kind");
  });

  it("read kind=status fetches the Hyperliquid status endpoint", async () => {
    installFetchMock({
      "/api/hyperliquid/status": {
        publicReadReady: true,
        signerReady: false,
        executionReady: false,
        executionBlockedReason: "no signer",
        accountAddress: null,
        apiBaseUrl: "https://api.hyperliquid.xyz",
        credentialMode: "none",
        readiness: {
          publicReads: true,
          accountReads: false,
          signer: false,
          execution: false,
        },
        account: { address: null, source: "none", guidance: null },
        vault: {
          configured: false,
          ready: false,
          address: null,
          guidance: "",
        },
        apiWallet: { configured: false, guidance: "" },
      },
    });
    const service = await startService();
    const { result } = await invoke(
      { action: "read", kind: "status" },
      service,
    );
    expect(result.success).toBe(true);
    expect(typeof result.text).toBe("string");
    const data = result.data as Record<string, unknown>;
    expect(data.kind).toBe("status");
    expect(data.op).toBe("read");
    expect(data.target).toBe("hyperliquid");
  });

  it("place_order is scaffolded but disabled", async () => {
    installFetchMock({
      "/api/hyperliquid/status": {
        publicReadReady: true,
        signerReady: false,
        executionReady: false,
        executionBlockedReason: "scaffold disabled in app",
        accountAddress: null,
        apiBaseUrl: "https://api.hyperliquid.xyz",
        credentialMode: "none",
        readiness: {
          publicReads: true,
          accountReads: false,
          signer: false,
          execution: false,
        },
        account: { address: null, source: "none", guidance: null },
        vault: {
          configured: false,
          ready: false,
          address: null,
          guidance: "",
        },
        apiWallet: { configured: false, guidance: "" },
      },
    });
    const service = await startService();
    const { result } = await invoke(
      { action: "place_order", coin: "BTC", side: "buy", size: 0.1 },
      service,
    );
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect((result.text ?? "").toLowerCase()).toContain("disabled");
    const data = result.data as { trading?: { enabled?: boolean } };
    expect(data.trading?.enabled).toBe(false);
  });

  it("accepts the legacy place-order alias via subaction", async () => {
    installFetchMock({
      "/api/hyperliquid/status": {
        publicReadReady: true,
        signerReady: false,
        executionReady: false,
        executionBlockedReason: "scaffold disabled",
        accountAddress: null,
        apiBaseUrl: "https://api.hyperliquid.xyz",
        credentialMode: "none",
        readiness: {
          publicReads: true,
          accountReads: false,
          signer: false,
          execution: false,
        },
        account: { address: null, source: "none", guidance: null },
        vault: {
          configured: false,
          ready: false,
          address: null,
          guidance: "",
        },
        apiWallet: { configured: false, guidance: "" },
      },
    });
    const service = await startService();
    const { result } = await invoke({ subaction: "place-order" }, service);
    expect(result.success).toBe(false);
    const data = result.data as { trading?: { enabled?: boolean } };
    expect(data.trading?.enabled).toBe(false);
  });

  it("read kind=markets fetches markets from the local API route", async () => {
    installFetchMock({
      "/api/hyperliquid/markets": {
        markets: [
          {
            name: "BTC",
            index: 0,
            szDecimals: 5,
            maxLeverage: 50,
            onlyIsolated: false,
            isDelisted: false,
          },
        ],
        source: "hyperliquid-info-meta",
        fetchedAt: "2026-04-29T12:00:00.000Z",
      },
    });
    const service = await startService();
    const { result } = await invoke(
      { action: "read", kind: "markets" },
      service,
    );
    expect(result.success).toBe(true);
    const data = result.data as { kind?: string; markets?: unknown[] };
    expect(data.kind).toBe("markets");
    expect(Array.isArray(data.markets)).toBe(true);
  });

  it("read kind=funding reports the not-yet-wired rationale", async () => {
    installFetchMock({});
    const service = await startService();
    const { result } = await invoke(
      { action: "read", kind: "funding" },
      service,
    );
    expect(result.success).toBe(true);
    const data = result.data as { kind?: string; notWired?: boolean };
    expect(data.kind).toBe("funding");
    expect(data.notWired).toBe(true);
  });

  it("read kind=market requires a coin/asset identifier", async () => {
    installFetchMock({});
    const service = await startService();
    const { result } = await invoke(
      { action: "read", kind: "market" },
      service,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("missing_market_identifier");
  });

  it("rejects unknown perpetual market provider targets", async () => {
    installFetchMock({});
    const service = await startService();
    const { result } = await invoke(
      { action: "read", kind: "status", target: "dydx" },
      service,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("UNSUPPORTED_PROVIDER");
  });
});
