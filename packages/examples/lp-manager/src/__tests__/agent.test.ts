import { afterEach, beforeEach, describe, expect, test } from "vitest";

// =============================================================================
// Test loadConfigFromEnv logic
// =============================================================================

interface LpAgentConfig {
  userId: string;
  solanaPrivateKey?: string;
  solanaRpcUrl?: string;
  evmPrivateKey?: string;
  evmRpcUrls?: Record<string, string | undefined>;
  checkIntervalMs?: number;
  minGainThresholdPercent?: number;
  maxSlippageBps?: number;
  autoRebalanceEnabled?: boolean;
  concentratedRepositionThreshold?: number;
  maxPositionSizeUsd?: number;
  minPoolTvlUsd?: number;
  maxIlRiskPercent?: number;
  solanaDexes?: string;
  evmDexes?: string;
}

function loadConfigFromEnv(): LpAgentConfig {
  const num = (k: string, d: number) => {
    const v = process.env[k];
    if (!v) return d;
    const n = Number(v);
    return Number.isNaN(n) ? d : n;
  };
  return {
    userId: process.env.LP_USER_ID ?? `lp-${Date.now()}`,
    solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY,
    solanaRpcUrl:
      process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    evmPrivateKey: process.env.EVM_PRIVATE_KEY,
    evmRpcUrls: {
      ethereum: process.env.ETHEREUM_RPC_URL,
      base: process.env.BASE_RPC_URL,
      arbitrum: process.env.ARBITRUM_RPC_URL,
      bsc: process.env.BSC_RPC_URL,
      polygon: process.env.POLYGON_RPC_URL,
      optimism: process.env.OPTIMISM_RPC_URL,
    },
    checkIntervalMs: num("LP_CHECK_INTERVAL_MS", 300000),
    minGainThresholdPercent: num("LP_MIN_GAIN_THRESHOLD_PERCENT", 1.0),
    maxSlippageBps: num("LP_MAX_SLIPPAGE_BPS", 50),
    autoRebalanceEnabled: process.env.LP_AUTO_REBALANCE_ENABLED !== "false",
    concentratedRepositionThreshold: num(
      "LP_CONCENTRATED_REPOSITION_THRESHOLD",
      0.1,
    ),
    maxPositionSizeUsd: num("LP_MAX_POSITION_SIZE_USD", 10000),
    minPoolTvlUsd: num("LP_MIN_POOL_TVL_USD", 100000),
    maxIlRiskPercent: num("LP_MAX_IL_RISK_PERCENT", 10),
    solanaDexes: process.env.LP_SOLANA_DEXES,
    evmDexes: process.env.LP_EVM_DEXES,
  };
}

// =============================================================================
// Test chain detection
// =============================================================================

const SOLANA_DEXES = new Set(["raydium", "orca", "meteora"]);

function getChainFromDex(dex: string): "solana" | "evm" {
  return SOLANA_DEXES.has(dex.toLowerCase()) ? "solana" : "evm";
}

// =============================================================================
// Tests: Environment Config Loading
// =============================================================================

// =============================================================================
// Tests: autoRebalanceEnabled parsing (LARP fix)
// =============================================================================

describe("autoRebalanceEnabled parsing", () => {
  const savedEnv = process.env.LP_AUTO_REBALANCE_ENABLED;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.LP_AUTO_REBALANCE_ENABLED;
    } else {
      process.env.LP_AUTO_REBALANCE_ENABLED = savedEnv;
    }
  });

  const parseAutoRebalance = (val: string | undefined): boolean => {
    return !["false", "0", "no", "off", "disabled"].includes(
      (val ?? "").toLowerCase(),
    );
  };

  test("enabled by default (undefined)", () => {
    expect(parseAutoRebalance(undefined)).toBe(true);
  });

  test("enabled for empty string", () => {
    expect(parseAutoRebalance("")).toBe(true);
  });

  test('enabled for "true"', () => {
    expect(parseAutoRebalance("true")).toBe(true);
  });

  test('enabled for "1"', () => {
    expect(parseAutoRebalance("1")).toBe(true);
  });

  test('enabled for "yes"', () => {
    expect(parseAutoRebalance("yes")).toBe(true);
  });

  test('disabled for "false"', () => {
    expect(parseAutoRebalance("false")).toBe(false);
  });

  test('disabled for "False" (case insensitive)', () => {
    expect(parseAutoRebalance("False")).toBe(false);
  });

  test('disabled for "FALSE" (case insensitive)', () => {
    expect(parseAutoRebalance("FALSE")).toBe(false);
  });

  test('disabled for "0"', () => {
    expect(parseAutoRebalance("0")).toBe(false);
  });

  test('disabled for "no"', () => {
    expect(parseAutoRebalance("no")).toBe(false);
  });

  test('disabled for "No" (case insensitive)', () => {
    expect(parseAutoRebalance("No")).toBe(false);
  });

  test('disabled for "off"', () => {
    expect(parseAutoRebalance("off")).toBe(false);
  });

  test('disabled for "disabled"', () => {
    expect(parseAutoRebalance("disabled")).toBe(false);
  });

  test("enabled for random string", () => {
    expect(parseAutoRebalance("random")).toBe(true);
  });
});

describe("loadConfigFromEnv", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save current env
    const keys = [
      "LP_USER_ID",
      "SOLANA_PRIVATE_KEY",
      "SOLANA_RPC_URL",
      "EVM_PRIVATE_KEY",
      "ETHEREUM_RPC_URL",
      "BASE_RPC_URL",
      "ARBITRUM_RPC_URL",
      "BSC_RPC_URL",
      "POLYGON_RPC_URL",
      "OPTIMISM_RPC_URL",
      "LP_CHECK_INTERVAL_MS",
      "LP_MIN_GAIN_THRESHOLD_PERCENT",
      "LP_MAX_SLIPPAGE_BPS",
      "LP_AUTO_REBALANCE_ENABLED",
      "LP_CONCENTRATED_REPOSITION_THRESHOLD",
      "LP_MAX_POSITION_SIZE_USD",
      "LP_MIN_POOL_TVL_USD",
      "LP_MAX_IL_RISK_PERCENT",
      "LP_SOLANA_DEXES",
      "LP_EVM_DEXES",
    ];
    for (const k of keys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  test("generates user ID when not provided", () => {
    const config = loadConfigFromEnv();
    expect(config.userId).toMatch(/^lp-\d+$/);
  });

  test("uses provided user ID", () => {
    process.env.LP_USER_ID = "custom-user";
    const config = loadConfigFromEnv();
    expect(config.userId).toBe("custom-user");
  });

  test("defaults solanaRpcUrl to mainnet", () => {
    const config = loadConfigFromEnv();
    expect(config.solanaRpcUrl).toBe("https://api.mainnet-beta.solana.com");
  });

  test("uses custom solana RPC URL", () => {
    process.env.SOLANA_RPC_URL = "https://my-rpc.example.com";
    const config = loadConfigFromEnv();
    expect(config.solanaRpcUrl).toBe("https://my-rpc.example.com");
  });

  test("collects all EVM RPC URLs", () => {
    process.env.ETHEREUM_RPC_URL = "https://eth.example.com";
    process.env.BASE_RPC_URL = "https://base.example.com";
    const config = loadConfigFromEnv();
    expect(config.evmRpcUrls?.ethereum).toBe("https://eth.example.com");
    expect(config.evmRpcUrls?.base).toBe("https://base.example.com");
    expect(config.evmRpcUrls?.arbitrum).toBeUndefined();
  });

  test("defaults checkIntervalMs to 5 minutes", () => {
    const config = loadConfigFromEnv();
    expect(config.checkIntervalMs).toBe(300000);
  });

  test("parses custom check interval", () => {
    process.env.LP_CHECK_INTERVAL_MS = "60000";
    const config = loadConfigFromEnv();
    expect(config.checkIntervalMs).toBe(60000);
  });

  test("defaults minGainThresholdPercent to 1.0", () => {
    const config = loadConfigFromEnv();
    expect(config.minGainThresholdPercent).toBe(1.0);
  });

  test("parses decimal threshold", () => {
    process.env.LP_MIN_GAIN_THRESHOLD_PERCENT = "0.5";
    const config = loadConfigFromEnv();
    expect(config.minGainThresholdPercent).toBe(0.5);
  });

  test("defaults maxSlippageBps to 50", () => {
    const config = loadConfigFromEnv();
    expect(config.maxSlippageBps).toBe(50);
  });

  test("autoRebalanceEnabled defaults to true", () => {
    const config = loadConfigFromEnv();
    expect(config.autoRebalanceEnabled).toBe(true);
  });

  test("autoRebalanceEnabled false when explicitly set", () => {
    process.env.LP_AUTO_REBALANCE_ENABLED = "false";
    const config = loadConfigFromEnv();
    expect(config.autoRebalanceEnabled).toBe(false);
  });

  test("autoRebalanceEnabled true for any other value", () => {
    process.env.LP_AUTO_REBALANCE_ENABLED = "no";
    const config = loadConfigFromEnv();
    expect(config.autoRebalanceEnabled).toBe(true);
  });

  test("handles invalid numeric values by using default", () => {
    process.env.LP_CHECK_INTERVAL_MS = "not-a-number";
    const config = loadConfigFromEnv();
    expect(config.checkIntervalMs).toBe(300000);
  });

  test("handles empty string as falsy", () => {
    process.env.LP_CHECK_INTERVAL_MS = "";
    const config = loadConfigFromEnv();
    expect(config.checkIntervalMs).toBe(300000);
  });

  test("parses all default values correctly", () => {
    const config = loadConfigFromEnv();
    expect(config.concentratedRepositionThreshold).toBe(0.1);
    expect(config.maxPositionSizeUsd).toBe(10000);
    expect(config.minPoolTvlUsd).toBe(100000);
    expect(config.maxIlRiskPercent).toBe(10);
  });

  test("returns undefined for missing private keys", () => {
    const config = loadConfigFromEnv();
    expect(config.solanaPrivateKey).toBeUndefined();
    expect(config.evmPrivateKey).toBeUndefined();
  });

  test("preserves private keys when provided", () => {
    process.env.SOLANA_PRIVATE_KEY = "base58key";
    process.env.EVM_PRIVATE_KEY = "0xhexkey";
    const config = loadConfigFromEnv();
    expect(config.solanaPrivateKey).toBe("base58key");
    expect(config.evmPrivateKey).toBe("0xhexkey");
  });

  test("preserves DEX preferences", () => {
    process.env.LP_SOLANA_DEXES = "raydium,orca";
    process.env.LP_EVM_DEXES = "uniswap,aerodrome";
    const config = loadConfigFromEnv();
    expect(config.solanaDexes).toBe("raydium,orca");
    expect(config.evmDexes).toBe("uniswap,aerodrome");
  });
});

// =============================================================================
// Tests: Chain Detection
// =============================================================================

describe("getChainFromDex", () => {
  test("identifies Raydium as Solana", () => {
    expect(getChainFromDex("raydium")).toBe("solana");
    expect(getChainFromDex("Raydium")).toBe("solana");
    expect(getChainFromDex("RAYDIUM")).toBe("solana");
  });

  test("identifies Orca as Solana", () => {
    expect(getChainFromDex("orca")).toBe("solana");
    expect(getChainFromDex("Orca")).toBe("solana");
  });

  test("identifies Meteora as Solana", () => {
    expect(getChainFromDex("meteora")).toBe("solana");
    expect(getChainFromDex("Meteora")).toBe("solana");
  });

  test("identifies Uniswap as EVM", () => {
    expect(getChainFromDex("uniswap")).toBe("evm");
    expect(getChainFromDex("Uniswap")).toBe("evm");
  });

  test("identifies PancakeSwap as EVM", () => {
    expect(getChainFromDex("pancakeswap")).toBe("evm");
    expect(getChainFromDex("PancakeSwap")).toBe("evm");
  });

  test("identifies Aerodrome as EVM", () => {
    expect(getChainFromDex("aerodrome")).toBe("evm");
  });

  test("unknown DEXes default to EVM", () => {
    expect(getChainFromDex("unknown-dex")).toBe("evm");
    expect(getChainFromDex("curve")).toBe("evm");
    expect(getChainFromDex("balancer")).toBe("evm");
  });

  test("handles empty string as EVM", () => {
    expect(getChainFromDex("")).toBe("evm");
  });
});

// =============================================================================
// Tests: Settings Builder
// =============================================================================

describe("Settings Builder", () => {
  interface BuildableConfig {
    solanaPrivateKey?: string;
    solanaRpcUrl?: string;
    evmPrivateKey?: string;
    evmRpcUrls?: Record<string, string | undefined>;
    checkIntervalMs?: number;
    minGainThresholdPercent?: number;
    maxSlippageBps?: number;
    autoRebalanceEnabled?: boolean;
    concentratedRepositionThreshold?: number;
    maxPositionSizeUsd?: number;
    minPoolTvlUsd?: number;
    maxIlRiskPercent?: number;
    solanaDexes?: string | string[];
    evmDexes?: string | string[];
  }

  function buildSettings(c: BuildableConfig): Record<string, string> {
    const s: Record<string, string> = {};

    if (c.solanaPrivateKey) s.SOLANA_PRIVATE_KEY = c.solanaPrivateKey;
    if (c.solanaRpcUrl) s.SOLANA_RPC_URL = c.solanaRpcUrl;
    if (c.evmPrivateKey) s.EVM_PRIVATE_KEY = c.evmPrivateKey;

    const rpcs = c.evmRpcUrls ?? {};
    if (rpcs.ethereum) s.ETHEREUM_RPC_URL = rpcs.ethereum;
    if (rpcs.base) s.BASE_RPC_URL = rpcs.base;
    if (rpcs.arbitrum) s.ARBITRUM_RPC_URL = rpcs.arbitrum;
    if (rpcs.bsc) s.BSC_RPC_URL = rpcs.bsc;
    if (rpcs.polygon) s.POLYGON_RPC_URL = rpcs.polygon;
    if (rpcs.optimism) s.OPTIMISM_RPC_URL = rpcs.optimism;

    if (c.checkIntervalMs !== undefined)
      s.LP_CHECK_INTERVAL_MS = String(c.checkIntervalMs);
    if (c.minGainThresholdPercent !== undefined)
      s.LP_MIN_GAIN_THRESHOLD_PERCENT = String(c.minGainThresholdPercent);
    if (c.maxSlippageBps !== undefined)
      s.LP_MAX_SLIPPAGE_BPS = String(c.maxSlippageBps);
    if (c.autoRebalanceEnabled !== undefined)
      s.LP_AUTO_REBALANCE_ENABLED = String(c.autoRebalanceEnabled);
    if (c.concentratedRepositionThreshold !== undefined)
      s.LP_CONCENTRATED_REPOSITION_THRESHOLD = String(
        c.concentratedRepositionThreshold,
      );
    if (c.maxPositionSizeUsd !== undefined)
      s.LP_MAX_POSITION_SIZE_USD = String(c.maxPositionSizeUsd);
    if (c.minPoolTvlUsd !== undefined)
      s.LP_MIN_POOL_TVL_USD = String(c.minPoolTvlUsd);
    if (c.maxIlRiskPercent !== undefined)
      s.LP_MAX_IL_RISK_PERCENT = String(c.maxIlRiskPercent);

    if (c.solanaDexes)
      s.LP_SOLANA_DEXES = Array.isArray(c.solanaDexes)
        ? c.solanaDexes.join(",")
        : c.solanaDexes;
    if (c.evmDexes)
      s.LP_EVM_DEXES = Array.isArray(c.evmDexes)
        ? c.evmDexes.join(",")
        : c.evmDexes;

    return s;
  }

  test("returns empty object for empty config", () => {
    const settings = buildSettings({});
    expect(Object.keys(settings)).toHaveLength(0);
  });

  test("includes Solana credentials when provided", () => {
    const settings = buildSettings({
      solanaPrivateKey: "key123",
      solanaRpcUrl: "https://rpc.example.com",
    });
    expect(settings.SOLANA_PRIVATE_KEY).toBe("key123");
    expect(settings.SOLANA_RPC_URL).toBe("https://rpc.example.com");
  });

  test("includes EVM credentials when provided", () => {
    const settings = buildSettings({
      evmPrivateKey: "0xkey456",
    });
    expect(settings.EVM_PRIVATE_KEY).toBe("0xkey456");
  });

  test("maps EVM RPC URLs correctly", () => {
    const settings = buildSettings({
      evmRpcUrls: {
        ethereum: "https://eth.example.com",
        base: "https://base.example.com",
        polygon: "https://polygon.example.com",
      },
    });
    expect(settings.ETHEREUM_RPC_URL).toBe("https://eth.example.com");
    expect(settings.BASE_RPC_URL).toBe("https://base.example.com");
    expect(settings.POLYGON_RPC_URL).toBe("https://polygon.example.com");
    expect(settings.ARBITRUM_RPC_URL).toBeUndefined();
  });

  test("converts numeric values to strings", () => {
    const settings = buildSettings({
      checkIntervalMs: 60000,
      minGainThresholdPercent: 1.5,
      maxSlippageBps: 100,
    });
    expect(settings.LP_CHECK_INTERVAL_MS).toBe("60000");
    expect(settings.LP_MIN_GAIN_THRESHOLD_PERCENT).toBe("1.5");
    expect(settings.LP_MAX_SLIPPAGE_BPS).toBe("100");
  });

  test("converts boolean to string", () => {
    const settingsTrue = buildSettings({ autoRebalanceEnabled: true });
    const settingsFalse = buildSettings({ autoRebalanceEnabled: false });
    expect(settingsTrue.LP_AUTO_REBALANCE_ENABLED).toBe("true");
    expect(settingsFalse.LP_AUTO_REBALANCE_ENABLED).toBe("false");
  });

  test("handles array DEX preferences", () => {
    const settings = buildSettings({
      solanaDexes: ["raydium", "orca", "meteora"],
      evmDexes: ["uniswap", "aerodrome"],
    });
    expect(settings.LP_SOLANA_DEXES).toBe("raydium,orca,meteora");
    expect(settings.LP_EVM_DEXES).toBe("uniswap,aerodrome");
  });

  test("handles string DEX preferences", () => {
    const settings = buildSettings({
      solanaDexes: "raydium,orca",
      evmDexes: "uniswap",
    });
    expect(settings.LP_SOLANA_DEXES).toBe("raydium,orca");
    expect(settings.LP_EVM_DEXES).toBe("uniswap");
  });

  test("omits undefined values from output", () => {
    const settings = buildSettings({
      checkIntervalMs: 60000,
      // All others undefined
    });
    expect(Object.keys(settings)).toEqual(["LP_CHECK_INTERVAL_MS"]);
  });

  test("handles zero values correctly", () => {
    const settings = buildSettings({
      checkIntervalMs: 0,
      minGainThresholdPercent: 0,
    });
    expect(settings.LP_CHECK_INTERVAL_MS).toBe("0");
    expect(settings.LP_MIN_GAIN_THRESHOLD_PERCENT).toBe("0");
  });

  test("handles negative values", () => {
    // Edge case: negative interval shouldn't happen but shouldn't crash
    const settings = buildSettings({
      checkIntervalMs: -1000,
    });
    expect(settings.LP_CHECK_INTERVAL_MS).toBe("-1000");
  });
});

// =============================================================================
// Tests: Position Summary Mapping
// =============================================================================

describe("Position Summary Mapping", () => {
  interface MonitoredPosition {
    position: {
      poolId: string;
      dex: string;
      underlyingTokens: Array<{ symbol?: string }>;
      valueUsd?: number;
    };
    currentApr: number;
    isConcentrated: boolean;
    priceDistanceFromRange: number | null;
    warnings: string[];
    rebalancable: boolean;
    rebalanceBlockedReason?: string;
    volume24h?: number;
  }

  interface PositionSummary {
    poolId: string;
    dex: string;
    chain: "solana" | "evm";
    tokenA: string;
    tokenB: string;
    valueUsd: number;
    currentApr: number;
    isConcentrated: boolean;
    inRange: boolean;
    priceDistancePercent: number | null;
    warnings: string[];
    rebalancable: boolean;
    rebalanceBlockedReason?: string;
    volume24h?: number;
  }

  function mapPositionToSummary(p: MonitoredPosition): PositionSummary {
    return {
      poolId: p.position.poolId,
      dex: p.position.dex,
      chain: SOLANA_DEXES.has(p.position.dex.toLowerCase()) ? "solana" : "evm",
      tokenA: p.position.underlyingTokens[0]?.symbol ?? "?",
      tokenB: p.position.underlyingTokens[1]?.symbol ?? "?",
      valueUsd: p.position.valueUsd ?? 0,
      currentApr: p.currentApr,
      isConcentrated: p.isConcentrated,
      inRange: (p.priceDistanceFromRange ?? 0) <= 0,
      priceDistancePercent: p.priceDistanceFromRange,
      warnings: p.warnings,
      rebalancable: p.rebalancable,
      rebalanceBlockedReason: p.rebalanceBlockedReason,
      volume24h: p.volume24h,
    };
  }

  test("maps basic position correctly", () => {
    const pos: MonitoredPosition = {
      position: {
        poolId: "pool-123",
        dex: "raydium",
        underlyingTokens: [{ symbol: "SOL" }, { symbol: "USDC" }],
        valueUsd: 1000,
      },
      currentApr: 0.25,
      isConcentrated: false,
      priceDistanceFromRange: null,
      warnings: [],
      rebalancable: true,
    };

    const summary = mapPositionToSummary(pos);
    expect(summary.poolId).toBe("pool-123");
    expect(summary.dex).toBe("raydium");
    expect(summary.chain).toBe("solana");
    expect(summary.tokenA).toBe("SOL");
    expect(summary.tokenB).toBe("USDC");
    expect(summary.valueUsd).toBe(1000);
    expect(summary.currentApr).toBe(0.25);
    expect(summary.isConcentrated).toBe(false);
    expect(summary.inRange).toBe(true);
  });

  test("handles missing token symbols", () => {
    const pos: MonitoredPosition = {
      position: {
        poolId: "pool-123",
        dex: "uniswap",
        underlyingTokens: [],
        valueUsd: 500,
      },
      currentApr: 0.1,
      isConcentrated: false,
      priceDistanceFromRange: null,
      warnings: [],
      rebalancable: true,
    };

    const summary = mapPositionToSummary(pos);
    expect(summary.tokenA).toBe("?");
    expect(summary.tokenB).toBe("?");
  });

  test("handles one token with symbol, one without", () => {
    const pos: MonitoredPosition = {
      position: {
        poolId: "pool-123",
        dex: "uniswap",
        underlyingTokens: [{ symbol: "ETH" }, {}],
        valueUsd: 500,
      },
      currentApr: 0.1,
      isConcentrated: false,
      priceDistanceFromRange: null,
      warnings: [],
      rebalancable: true,
    };

    const summary = mapPositionToSummary(pos);
    expect(summary.tokenA).toBe("ETH");
    expect(summary.tokenB).toBe("?");
  });

  test("handles missing valueUsd", () => {
    const pos: MonitoredPosition = {
      position: {
        poolId: "pool-123",
        dex: "uniswap",
        underlyingTokens: [],
      },
      currentApr: 0,
      isConcentrated: false,
      priceDistanceFromRange: null,
      warnings: [],
      rebalancable: false,
    };

    const summary = mapPositionToSummary(pos);
    expect(summary.valueUsd).toBe(0);
  });

  test("determines in-range for concentrated liquidity", () => {
    const inRange: MonitoredPosition = {
      position: { poolId: "p", dex: "orca", underlyingTokens: [] },
      currentApr: 0.2,
      isConcentrated: true,
      priceDistanceFromRange: -50, // Negative = in range
      warnings: [],
      rebalancable: true,
    };

    const outOfRange: MonitoredPosition = {
      position: { poolId: "p", dex: "orca", underlyingTokens: [] },
      currentApr: 0.2,
      isConcentrated: true,
      priceDistanceFromRange: 10, // Positive = out of range
      warnings: [],
      rebalancable: true,
    };

    expect(mapPositionToSummary(inRange).inRange).toBe(true);
    expect(mapPositionToSummary(outOfRange).inRange).toBe(false);
  });

  test("treats null priceDistance as in-range", () => {
    const pos: MonitoredPosition = {
      position: { poolId: "p", dex: "meteora", underlyingTokens: [] },
      currentApr: 0.15,
      isConcentrated: false,
      priceDistanceFromRange: null,
      warnings: [],
      rebalancable: true,
    };

    expect(mapPositionToSummary(pos).inRange).toBe(true);
  });

  test("preserves warnings array", () => {
    const pos: MonitoredPosition = {
      position: { poolId: "p", dex: "raydium", underlyingTokens: [] },
      currentApr: 0.01,
      isConcentrated: false,
      priceDistanceFromRange: null,
      warnings: ["Low APR: 1%", "Unclaimed rewards: $50"],
      rebalancable: true,
    };

    const summary = mapPositionToSummary(pos);
    expect(summary.warnings).toHaveLength(2);
    expect(summary.warnings[0]).toContain("Low APR");
  });

  test("maps rebalancability status", () => {
    const locked: MonitoredPosition = {
      position: { poolId: "p", dex: "orca", underlyingTokens: [] },
      currentApr: 0.2,
      isConcentrated: false,
      priceDistanceFromRange: null,
      warnings: [],
      rebalancable: false,
      rebalanceBlockedReason: "Position locked",
    };

    const summary = mapPositionToSummary(locked);
    expect(summary.rebalancable).toBe(false);
    expect(summary.rebalanceBlockedReason).toBe("Position locked");
  });

  test("preserves volume24h when present", () => {
    const pos: MonitoredPosition = {
      position: { poolId: "p", dex: "raydium", underlyingTokens: [] },
      currentApr: 0.25,
      isConcentrated: false,
      priceDistanceFromRange: null,
      warnings: [],
      rebalancable: true,
      volume24h: 1500000,
    };

    expect(mapPositionToSummary(pos).volume24h).toBe(1500000);
  });
});
