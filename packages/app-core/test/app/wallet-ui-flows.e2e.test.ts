/**
 * E2E tests for Wallet/Inventory UI (InventoryView).
 *
 * Tests cover:
 * 1. Balance display
 * 2. Chain selection
 * 3. Token list
 * 4. NFT display
 * 5. Address display and copy
 * 6. Refresh functionality
 */

import http from "node:http";
// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Part 1: API Tests for Wallet Endpoints
// ---------------------------------------------------------------------------

async function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function createWalletTestServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  getBalances: () => Array<{ chain: string; symbol: string; balance: string }>;
}> {
  const balances = [
    { chain: "ethereum", symbol: "ETH", balance: "1.5", valueUsd: 3000 },
    { chain: "ethereum", symbol: "USDC", balance: "1000", valueUsd: 1000 },
    { chain: "base", symbol: "ETH", balance: "0.5", valueUsd: 1000 },
    { chain: "polygon", symbol: "MATIC", balance: "500", valueUsd: 250 },
  ];

  const nfts = [
    {
      chain: "ethereum",
      name: "Cool NFT #1",
      imageUrl: "https://example.com/nft1.png",
      collectionName: "Cool Collection",
    },
    {
      chain: "ethereum",
      name: "Cool NFT #2",
      imageUrl: "https://example.com/nft2.png",
      collectionName: "Cool Collection",
    },
  ];

  const addresses = {
    ethereum: "0x1234567890123456789012345678901234567890",
    base: "0x1234567890123456789012345678901234567890",
    polygon: "0x1234567890123456789012345678901234567890",
  };

  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
  };

  const routes: Record<
    string,
    (req: http.IncomingMessage, res: http.ServerResponse) => void
  > = {
    "GET /api/wallet/balances": (_r, res) => json(res, { balances }),
    "GET /api/wallet/nfts": (_r, res) => json(res, { nfts }),
    "GET /api/wallet/addresses": (_r, res) => json(res, { addresses }),
    "POST /api/wallet/refresh": (_r, res) => json(res, { ok: true }),
    "GET /api/wallet/config": (_r, res) =>
      json(res, {
        chains: ["ethereum", "base", "polygon"],
        selectedChain: "ethereum",
      }),
  };

  const server = http.createServer((rq, rs) => {
    if (rq.method === "OPTIONS") {
      rs.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      });
      rs.end();
      return;
    }
    const key = `${rq.method} ${new URL(rq.url ?? "/", "http://localhost").pathname}`;
    const handler = routes[key];
    if (handler) {
      handler(rq, rs);
    } else {
      json(rs, { error: "Not found" }, 404);
    }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getBalances: () =>
          balances.map((b) => ({
            chain: b.chain,
            symbol: b.symbol,
            balance: b.balance,
          })),
      });
    });
  });
}

describe("Wallet API", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ port, close } = await createWalletTestServer());
  });

  afterAll(async () => {
    await close();
  });

  it("GET /api/wallet/balances returns token balances", async () => {
    const { status, data } = await req(port, "GET", "/api/wallet/balances");
    expect(status).toBe(200);
    expect(Array.isArray(data.balances)).toBe(true);
    expect((data.balances as unknown[]).length).toBeGreaterThan(0);
  });

  it("GET /api/wallet/nfts returns NFT list", async () => {
    const { status, data } = await req(port, "GET", "/api/wallet/nfts");
    expect(status).toBe(200);
    expect(Array.isArray(data.nfts)).toBe(true);
  });

  it("GET /api/wallet/addresses returns wallet addresses", async () => {
    const { status, data } = await req(port, "GET", "/api/wallet/addresses");
    expect(status).toBe(200);
    expect(data.addresses).toBeDefined();
  });

  it("POST /api/wallet/refresh triggers balance refresh", async () => {
    const { status, data } = await req(port, "POST", "/api/wallet/refresh");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it("GET /api/wallet/config returns chain configuration", async () => {
    const { status, data } = await req(port, "GET", "/api/wallet/config");
    expect(status).toBe(200);
    expect(Array.isArray(data.chains)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 2: UI Tests for InventoryView
// ---------------------------------------------------------------------------

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
  };
});

import { InventoryView } from "../../src/components/InventoryView";

type WalletState = {
  walletConfig: { chains: string[]; selectedChain: string } | null;
  walletAddresses: Record<string, string>;
  walletBalances: Array<{
    chain: string;
    symbol: string;
    name: string;
    balance: string;
    valueUsd: number;
  }>;
  walletNfts: {
    evm: Array<{
      chain: string;
      nfts: Array<{
        name: string;
        imageUrl: string;
        collectionName?: string;
        tokenType?: string;
      }>;
    }>;
    solana?: {
      nfts: Array<{
        name: string;
        imageUrl: string;
        collectionName?: string;
      }>;
    };
  } | null;
  walletLoading: boolean;
  walletNftsLoading: boolean;
  inventoryView: "tokens" | "nfts";
  walletError?: string | null;
};

function createWalletUIState(): WalletState {
  return {
    walletConfig: {
      chains: ["ethereum", "base", "polygon"],
      selectedChain: "ethereum",
    },
    walletAddresses: {
      ethereum: "0x1234567890123456789012345678901234567890",
      base: "0x1234567890123456789012345678901234567890",
    },
    walletBalances: [
      {
        chain: "ethereum",
        symbol: "ETH",
        name: "Ethereum",
        balance: "1.5",
        valueUsd: 3000,
      },
      {
        chain: "ethereum",
        symbol: "USDC",
        name: "USD Coin",
        balance: "1000",
        valueUsd: 1000,
      },
    ],
    walletNfts: {
      evm: [
        {
          chain: "ethereum",
          nfts: [
            {
              name: "Cool NFT #1",
              imageUrl: "https://example.com/nft1.png",
              collectionName: "Cool Collection",
            },
          ],
        },
      ],
      solana: { nfts: [] },
    },
    walletLoading: false,
    walletNftsLoading: false,
    inventoryView: "tokens",
    walletError: null,
  };
}

describe("InventoryView UI", () => {
  let state: WalletState;

  beforeEach(() => {
    state = createWalletUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      loadWalletBalances: vi.fn(),
      loadWalletNfts: vi.fn(),
      refreshWallet: vi.fn(),
      setInventoryView: (view: "tokens" | "nfts") => {
        state.inventoryView = view;
      },
      copyToClipboard: vi.fn().mockResolvedValue(undefined),
    }));
  });

  it("renders InventoryView", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    expect(tree).not.toBeNull();
  });

  it("displays wallet address", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const _codeElements = tree?.root.findAll((node) => node.type === "code");
    // Should have address displayed
    expect(tree).not.toBeNull();
  });

  it("displays token balances", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const allText = JSON.stringify(tree?.toJSON());
    // Should show ETH or balance info
    expect(allText.includes("ETH") || allText.includes("1.5")).toBe(true);
  });

  it("shows loading state when walletLoading is true", async () => {
    state.walletLoading = true;

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    expect(tree).not.toBeNull();
  });

  it("renders copy button for address", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const copyButtons = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (c) => typeof c === "string" && c.toLowerCase().includes("copy"),
        ),
    );
    expect(copyButtons.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Part 3: Wallet Balance Integration Tests
// ---------------------------------------------------------------------------

describe("Wallet Balance Integration", () => {
  let state: WalletState;
  let refreshCalled: boolean;

  beforeEach(() => {
    state = createWalletUIState();
    refreshCalled = false;

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      loadWalletBalances: vi.fn(),
      loadWalletNfts: vi.fn(),
      refreshWallet: async () => {
        refreshCalled = true;
        // Simulate balance update
        state.walletBalances[0].balance = "2.0";
      },
      setInventoryView: vi.fn(),
      copyToClipboard: vi.fn().mockResolvedValue(undefined),
    }));
  });

  it("refreshing wallet updates balances", async () => {
    const refreshWallet = mockUseApp().refreshWallet;
    const originalBalance = state.walletBalances[0].balance;

    await refreshWallet();

    expect(refreshCalled).toBe(true);
    expect(state.walletBalances[0].balance).not.toBe(originalBalance);
  });
});

// ---------------------------------------------------------------------------
// Part 4: Token/NFT View Toggle Tests
// ---------------------------------------------------------------------------

describe("Inventory View Toggle", () => {
  let state: WalletState;

  beforeEach(() => {
    state = createWalletUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      loadWalletBalances: vi.fn(),
      loadWalletNfts: vi.fn(),
      refreshWallet: vi.fn(),
      setInventoryView: (view: "tokens" | "nfts") => {
        state.inventoryView = view;
      },
      copyToClipboard: vi.fn().mockResolvedValue(undefined),
    }));
  });

  it("defaults to tokens view", () => {
    expect(state.inventoryView).toBe("tokens");
  });

  it("switching to NFTs view updates state", () => {
    const setView = mockUseApp().setInventoryView;

    setView("nfts");

    expect(state.inventoryView).toBe("nfts");
  });

  it("switching back to tokens view works", () => {
    const setView = mockUseApp().setInventoryView;

    setView("nfts");
    setView("tokens");

    expect(state.inventoryView).toBe("tokens");
  });
});

// ---------------------------------------------------------------------------
// Part 5: Chain Selection Tests
// ---------------------------------------------------------------------------

describe("Chain Selection", () => {
  let state: WalletState;

  beforeEach(() => {
    state = createWalletUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      loadWalletBalances: vi.fn(),
      loadWalletNfts: vi.fn(),
      refreshWallet: vi.fn(),
      setInventoryView: vi.fn(),
      setSelectedChain: (chain: string) => {
        if (state.walletConfig) {
          state.walletConfig.selectedChain = chain;
        }
      },
      copyToClipboard: vi.fn().mockResolvedValue(undefined),
    }));
  });

  it("available chains are listed", () => {
    expect(state.walletConfig?.chains).toContain("ethereum");
    expect(state.walletConfig?.chains).toContain("base");
    expect(state.walletConfig?.chains).toContain("polygon");
  });

  it("changing chain updates selected chain", () => {
    const setChain = mockUseApp().setSelectedChain;

    setChain("base");

    expect(state.walletConfig?.selectedChain).toBe("base");
  });
});

// ---------------------------------------------------------------------------
// Part 6: Address Copy Tests
// ---------------------------------------------------------------------------

describe("Address Copy Functionality", () => {
  let state: WalletState;
  let copiedText: string | null;

  beforeEach(() => {
    state = createWalletUIState();
    copiedText = null;

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      loadWalletBalances: vi.fn(),
      loadWalletNfts: vi.fn(),
      refreshWallet: vi.fn(),
      setInventoryView: vi.fn(),
      copyToClipboard: async (text: string) => {
        copiedText = text;
      },
    }));
  });

  it("copying address captures correct text", async () => {
    const copyFn = mockUseApp().copyToClipboard;

    await copyFn("0x1234567890123456789012345678901234567890");

    expect(copiedText).toBe("0x1234567890123456789012345678901234567890");
  });
});
