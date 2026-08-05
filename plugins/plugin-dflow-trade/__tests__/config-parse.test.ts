import { describe, expect, it } from "vitest";
import {
  readDflowTradeConfig,
  resolveMint,
  toAtomicAmount,
} from "../src/config.ts";
import { parseTradeIntent } from "../src/parse-trade.ts";

describe("dflow trade config", () => {
  it("uses prod API when DFLOW_API_KEY set", () => {
    const cfg = readDflowTradeConfig((k) =>
      k === "DFLOW_API_KEY" ? "test-key" : undefined,
    );
    expect(cfg.apiKey).toBe("test-key");
    expect(cfg.tradeApiUrl).toContain("quote-api.dflow.net");
    expect(cfg.tradeApiUrl).not.toContain("dev-");
  });

  it("uses dev API without key", () => {
    const cfg = readDflowTradeConfig(() => undefined);
    expect(cfg.tradeApiUrl).toContain("dev-quote-api.dflow.net");
  });

  it("reads HELIUS_RPC_URL and live flag", () => {
    const cfg = readDflowTradeConfig((k) => {
      if (k === "HELIUS_RPC_URL") return "https://mainnet.helius-rpc.com/?api-key=x";
      if (k === "SOLANA_TRADE_LIVE") return "true";
      if (k === "DEEPSEEK_API_KEY") return "sk-deep";
      return undefined;
    });
    expect(cfg.rpcUrl).toContain("helius");
    expect(cfg.liveEnabled).toBe(true);
    expect(cfg.deepseekConfigured).toBe(true);
  });
});

describe("mint + atomic amounts", () => {
  it("resolves SOL and USDC", () => {
    expect(resolveMint("SOL").mint).toMatch(/^So1111/);
    expect(resolveMint("usdc").decimals).toBe(6);
  });

  it("converts human SOL to lamports", () => {
    expect(toAtomicAmount("1", 9)).toBe("1000000000");
    expect(toAtomicAmount("0.01", 9)).toBe("10000000");
    expect(toAtomicAmount("1.5", 6)).toBe("1500000");
  });
});

describe("parseTradeIntent", () => {
  it("parses quote 0.01 SOL to USDC", () => {
    const p = parseTradeIntent("quote 0.01 SOL to USDC");
    expect(p).not.toBeNull();
    expect(p!.humanAmount).toBe("0.01");
    expect(p!.input.symbol).toBe("SOL");
    expect(p!.output.symbol).toBe("USDC");
    expect(p!.atomicAmount).toBe("10000000");
    expect(p!.previewOnly).toBe(true);
  });

  it("detects live execute language", () => {
    const p = parseTradeIntent("execute swap 0.01 SOL to USDC live");
    expect(p!.live).toBe(true);
    expect(p!.previewOnly).toBe(false);
  });

  it("keeps preview when dry-run said", () => {
    const p = parseTradeIntent("swap 1 USDC to SOL dry-run");
    expect(p!.previewOnly).toBe(true);
  });
});
