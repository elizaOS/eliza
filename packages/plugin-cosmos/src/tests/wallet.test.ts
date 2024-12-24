import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { walletProvider } from "../providers/wallet";
import { defaultCharacter } from "@ai16z/eliza";
import { ModelClass, State } from "@ai16z/eliza";
import { chains } from 'chain-registry/testnet';
import { executeTransfer } from "../actions/transfer";

// Mock NodeCache so there's no actual caching side effects
vi.mock("node-cache", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      set: vi.fn(),
      get: vi.fn().mockReturnValue(null),
    })),
  };
});

// Mock path if needed
vi.mock("path", async () => {
  const actual = await vi.importActual("path");
  return {
    ...actual,
    join: vi.fn().mockImplementation((...args) => args.join("/")),
  };
});

// For demonstration, we mock the entire stargate client so no real network calls
vi.mock("@cosmjs/stargate", () => {
  return {
    // Partial mock with the classes we need
    SigningStargateClient: {
      connectWithSigner: vi.fn().mockResolvedValue({
        getAllBalances: vi.fn().mockResolvedValue([
          { denom: "uosmo", amount: "1230000" }, // 1.23 OSMO
        ]),
        // Example account with minimal data
        getSignerAccounts: vi.fn().mockResolvedValue([
          { address: "osmo1mock..." },
        ]),
      }),
    },
  };
});

// (Optional) If you're testing price fetch from Coingecko, you can also mock fetch
vi.mock(globalThis.fetch ? 'node-fetch' : 'cross-fetch', () => ({
  __esModule: true,
  default: vi.fn().mockImplementation(() => ({
    ok: true,
    json: () =>
      Promise.resolve({
        osmosis: { usd: 0.9 }, // Example price for OSMO
      }),
  })),
}));

describe("Cosmos WalletProvider (getFormattedPortfolio)", () => {
  let mockedRuntime: any;
  let callbackFn: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default runtime mock
    mockedRuntime = {
      character: defaultCharacter,
      getSetting: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("uses environment variables for RPC, DENOM, and DECIMALS if set", async () => {
    // Set environment-based overrides
    mockedRuntime.getSetting.mockImplementation((key: string) => {
      switch (key) {
        case "COSMOS_MNEMONIC":
          return "unfold client turtle either pilot stock floor glow toward bullet car science";
        case "COSMOS_CHAIN_NAME":
          return "osmosis";
        case "COSMOS_RPC_URL":
          return "https://custom.env.rpc/";
        case "COSMOS_CHAIN_DENOM":
          return "uenvdenom";
        case "COSMOS_CHAIN_DECIMALS":
          return "4";
        case "COSMOS_BECH32_PREFIX":
          return "osmo1mock";
        default:
          return undefined;
      }
    });

    // Execute the provider
    const result = await walletProvider.get(mockedRuntime, {} as any);

    // Should mention chain and account address
    expect(result).toContain("Chain: osmosis");
    expect(result).toContain("Account Address: osmo1mock");

    // Should have "Token Balances:"
    expect(result).toContain("Token Balances:");

    // Symbol uppercase from the code => "UENVDENOM"
    expect(result).toContain("UENVDENOM");

    // Should show a total value line (like "Total Value: $1.10" or similar)
    // We'll just check the pattern:
    expect(result).toMatch(/Total Value: \$[\d,]*\.\d{2}/);

    // Optional: If you want to see the entire result in test logs
    // console.log("Portfolio result with env overrides:\n", result);
  });

  it("falls back to chain-registry if env variables are not set", async () => {
    // Minimal environment: just mnemonic + chain name
    mockedRuntime.getSetting.mockImplementation((key: string) => {
      switch (key) {
        case "COSMOS_MNEMONIC":
          return "unfold client turtle either pilot stock floor glow toward bullet car science";
        case "COSMOS_CHAIN_NAME":
          return "osmosistestnet";
        // No COSMOS_RPC_URL, COSMOS_CHAIN_DENOM, COSMOS_CHAIN_DECIMALS
        default:
          return undefined;
      }
    });

    // Confirm chain-registry has 'osmosis'
    const chain = chains.find((c) => c.chain_name === "osmosistestnet");
    expect(chain).toBeDefined();

    // Execute the provider
    const result = await walletProvider.get(mockedRuntime, {} as any);

    // Should mention chain and account address
    expect(result).toContain("Chain: osmosis");
    expect(result).toContain("Account Address: osmo1");

    // Should have "Token Balances:"
    expect(result).toContain("Token Balances:");

    // In fallback, the code sets denom to "uosmo", thus symbol => "UOSMO"
    expect(result).toContain("UOSMO");

    // Check total value
    expect(result).toMatch(/Total Value: \$[\d,]*\.\d{2}/);
  });

  it("returns null if COSMOS_MNEMONIC is not set", async () => {
    // We intentionally do not provide a mnemonic
    mockedRuntime.getSetting.mockImplementation((key: string) => {
      if (key === "COSMOS_CHAIN_NAME") return "osmosis";
      return undefined;
    });

    const result = await walletProvider.get(mockedRuntime, {} as any);

    // Should return null since the mnemonic is missing
    expect(result).toBeNull();
  });
});
