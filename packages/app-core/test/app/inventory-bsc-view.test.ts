import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

import { InventoryView } from "../../src/components/InventoryView";

function createWalletBalances(
  bnbBalance = "0.006",
  bscError: string | null = null,
) {
  return {
    evm: {
      address: "0x1111111111111111111111111111111111111111",
      chains: [
        {
          chain: "BSC",
          chainId: 56,
          nativeBalance: bnbBalance,
          nativeSymbol: "BNB",
          nativeValueUsd: "4.20",
          tokens: [
            {
              symbol: "CAKE",
              name: "PancakeSwap",
              contractAddress: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
              balance: "12.3",
              decimals: 18,
              valueUsd: "31.20",
              logoUrl: "",
            },
          ],
          error: bscError,
        },
        {
          chain: "Ethereum",
          chainId: 1,
          nativeBalance: "0.15",
          nativeSymbol: "ETH",
          nativeValueUsd: "460.00",
          tokens: [],
          error: null,
        },
      ],
    },
    solana: {
      address: "So11111111111111111111111111111111111111112",
      solBalance: "1.0",
      solValueUsd: "100.00",
      tokens: [],
    },
  };
}

function createEmptyWalletBalances() {
  return {
    evm: {
      address: "0x1111111111111111111111111111111111111111",
      chains: [
        {
          chain: "BSC",
          chainId: 56,
          nativeBalance: "0",
          nativeSymbol: "BNB",
          nativeValueUsd: "0",
          tokens: [],
          error: null,
        },
        {
          chain: "Ethereum",
          chainId: 1,
          nativeBalance: "0",
          nativeSymbol: "ETH",
          nativeValueUsd: "0",
          tokens: [],
          error: null,
        },
      ],
    },
    solana: {
      address: "So11111111111111111111111111111111111111112",
      solBalance: "0",
      solValueUsd: "0",
      tokens: [],
    },
  };
}

function createWalletConfig() {
  return {
    selectedRpcProviders: {
      evm: "alchemy",
      bsc: "nodereal",
      solana: "eliza-cloud",
    },
    legacyCustomChains: [],
    alchemyKeySet: true,
    infuraKeySet: false,
    ankrKeySet: true,
    nodeRealBscRpcSet: true,
    quickNodeBscRpcSet: true,
    managedBscRpcReady: true,
    cloudManagedAccess: true,
    evmBalanceReady: true,
    ethereumBalanceReady: true,
    baseBalanceReady: true,
    bscBalanceReady: true,
    avalancheBalanceReady: true,
    solanaBalanceReady: true,
    heliusKeySet: false,
    birdeyeKeySet: false,
    evmChains: ["Ethereum", "Base", "BSC"],
    evmAddress: "0x1111111111111111111111111111111111111111",
    solanaAddress: "So11111111111111111111111111111111111111112",
  };
}

function createPreflight(ok = true) {
  return {
    ok,
    walletAddress: "0x1111111111111111111111111111111111111111",
    rpcUrlHost: "bsc-mainnet.nodereal.io",
    chainId: 56,
    bnbBalance: "0.1",
    minGasBnb: "0.005",
    checks: {
      walletReady: true,
      rpcReady: true,
      chainReady: true,
      gasReady: true,
      tokenAddressValid: true,
    },
    reasons: [] as string[],
  };
}

function createQuote(side: "buy" | "sell" = "buy") {
  const isBuy = side === "buy";
  return {
    ok: true,
    side,
    routerAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    wrappedNativeAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    tokenAddress: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
    slippageBps: 500,
    route: isBuy
      ? [
          "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
          "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
        ]
      : [
          "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
          "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        ],
    quoteIn: isBuy
      ? { symbol: "BNB", amount: "0.1", amountWei: "100000000000000000" }
      : { symbol: "CAKE", amount: "1.0", amountWei: "1000000000000000000" },
    quoteOut: isBuy
      ? { symbol: "CAKE", amount: "2.5", amountWei: "2500000000000000000" }
      : { symbol: "BNB", amount: "0.03", amountWei: "30000000000000000" },
    minReceive: isBuy
      ? { symbol: "CAKE", amount: "2.375", amountWei: "2375000000000000000" }
      : { symbol: "BNB", amount: "0.0285", amountWei: "28500000000000000" },
    price: "25.0000",
    preflight: createPreflight(true),
  };
}

function createExecuteResult(
  executed = true,
  options?: {
    side?: "buy" | "sell";
    requiresApproval?: boolean;
    executionStatus?: "success" | "pending";
  },
) {
  const side = options?.side ?? "buy";
  const requiresApproval = options?.requiresApproval ?? false;
  const executionStatus = options?.executionStatus ?? "success";
  return {
    ok: true,
    side,
    mode: executed ? ("local-key" as const) : ("user-sign" as const),
    quote: createQuote(side),
    executed,
    requiresUserSignature: !executed,
    unsignedTx: {
      chainId: 56,
      from: "0x1111111111111111111111111111111111111111",
      to: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      data: "0x1234",
      valueWei: "100000000000000000",
      deadline: Math.floor(Date.now() / 1000) + 600,
      explorerUrl: "https://bscscan.com",
    },
    unsignedApprovalTx:
      !executed && side === "sell" && requiresApproval
        ? {
            chainId: 56,
            from: "0x1111111111111111111111111111111111111111",
            to: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
            data: "0xabcd",
            valueWei: "0",
            explorerUrl: "https://bscscan.com",
            spender: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
            amountWei: "1000000000000000000",
          }
        : undefined,
    requiresApproval:
      !executed && side === "sell" ? requiresApproval : undefined,
    execution: executed
      ? {
          hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          nonce: 12,
          gasLimit: "220000",
          valueWei: "100000000000000000",
          explorerUrl:
            "https://bscscan.com/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          blockNumber: 51_234_567,
          status: executionStatus,
        }
      : undefined,
  };
}

function createContext(
  overrides?: Partial<{
    inventoryView: "tokens" | "nfts";
    inventorySort: "chain" | "symbol" | "value";
    inventoryChainFocus: "bsc" | "all";
    walletBalances: ReturnType<typeof createWalletBalances> | null;
    walletConfig: ReturnType<typeof createWalletConfig> | null;
    elizaCloudConnected: boolean;
    walletError: string | null;
    t: (key: string) => string;
  }>,
) {
  const ctx: Record<string, unknown> = {
    walletConfig: createWalletConfig(),
    walletAddresses: {
      evmAddress: "0x1111111111111111111111111111111111111111",
      solanaAddress: "So11111111111111111111111111111111111111112",
    },
    walletBalances: createWalletBalances(),
    walletNfts: { evm: [], solana: null },
    walletLoading: false,
    walletNftsLoading: false,
    inventoryView: "tokens",
    inventorySort: "value",
    inventoryChainFocus: "all",
    inventoryCollapseOtherEvm: true,
    inventoryCollapseSolana: true,
    walletError: null,
    elizaCloudConnected: true,
    loadBalances: vi.fn(async () => {}),
    loadNfts: vi.fn(async () => {}),
    getBscTradePreflight: vi.fn(async () => createPreflight(true)),
    getBscTradeQuote: vi.fn(async (request?: { side?: "buy" | "sell" }) =>
      createQuote(request?.side ?? "buy"),
    ),
    executeBscTrade: vi.fn(async () => createExecuteResult(true)),
    getBscTradeTxStatus: vi.fn(async () => ({
      ok: true,
      hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "success" as const,
      explorerUrl:
        "https://bscscan.com/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chainId: 56,
      blockNumber: 51_234_567,
      confirmations: 7,
      nonce: 12,
      gasUsed: "180000",
      effectiveGasPriceWei: "3000000000",
    })),
    setTab: vi.fn(),
    setActionNotice: vi.fn(),
    copyToClipboard: vi.fn(async () => {}),
    uiLanguage: "en",
    t: (k: string) => k,
  };

  if (overrides) {
    Object.assign(ctx, overrides);
  }

  ctx.setState = vi.fn((key: string, value: unknown) => {
    ctx[key] = value;
  });

  return ctx;
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  try {
    localStorage.removeItem("wt_tracked_bsc_tokens");
  } catch {
    // ignore in non-browser test runtime
  }
});

describe("InventoryView unified wallets", () => {
  it("defaults to a unified all-chains wallet view", async () => {
    const ctx = createContext();
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const content = text(tree?.root);
    expect(content).not.toContain("wallet.portfolio");
    expect(content).not.toContain("All Chains");
    expect(content).toContain("wallet.tokens");
    expect(content).toContain("wallet.nfts");
    expect(content).toContain("wallet.all");
    expect(content).toContain("tokenstable.nativeGasEthereum");
    expect(content).toContain("tokenstable.nativeGasSolana");
    expect(
      tree?.root.findAll(
        (node) =>
          node.type === "button" &&
          node.props["data-testid"] === "wallet-token-preflight",
      ),
    ).toHaveLength(0);
  });

  it("shows no balances when every chain is empty", async () => {
    const ctx = createContext({
      walletBalances: createEmptyWalletBalances(),
      t: (key: string) =>
        key === "wallet.noTokensFound"
          ? "No tokens yet. Send your agent some tokens!"
          : key === "wallet.emptyTokensCta"
            ? "Use the wallet addresses below to fund this agent."
            : key === "wallet.copyEvmAddress"
              ? "Copy EVM address"
              : key === "wallet.copySolanaAddress"
                ? "Copy Solana address"
                : key,
    });
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const content = text(tree?.root);
    expect(content).toContain("No tokens yet. Send your agent some tokens!");
    expect(content).toContain("Copy EVM address");
    expect(content).toContain("Copy Solana address");
    expect(content).not.toContain("tokenstable.nativeGasEthereum");
    expect(content).not.toContain("tokenstable.nativeGasSolana");
  });

  it("switches focus with chain controls", async () => {
    const ctx = createContext();
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const chainSelect = tree?.root.findAll(
      (node) =>
        node.type === "select" &&
        node.props["data-testid"] === "wallet-chain-select",
    )[0];
    expect(chainSelect).toBeDefined();

    await act(async () => {
      chainSelect.props.onChange({ target: { value: "bsc" } });
    });
    expect(ctx.setState).toHaveBeenCalledWith("inventoryChainFocus", "bsc");

    await act(async () => {
      tree?.update(React.createElement(InventoryView));
    });

    const content = text(tree?.root);
    expect(content).not.toContain("All Chains");
    expect(content).not.toContain("Ethereum native");
    expect(
      tree?.root.findAll(
        (node) =>
          node.type === "button" &&
          node.props["data-testid"] === "wallet-token-preflight",
      ),
    ).toHaveLength(1);
  });

  it("applies BNB gas readiness threshold at 0.005", async () => {
    const lowCtx = createContext({
      inventoryChainFocus: "bsc",
      walletBalances: createWalletBalances("0.0049"),
    });
    mockUseApp.mockImplementation(() => lowCtx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });
    let content = text(tree?.root);
    expect(content).toContain("Trade Not Ready");

    const readyCtx = createContext({
      inventoryChainFocus: "bsc",
      walletBalances: createWalletBalances("0.005"),
    });
    mockUseApp.mockImplementation(() => readyCtx);
    await act(async () => {
      tree?.update(React.createElement(InventoryView));
    });
    content = text(tree?.root);
    expect(content).toContain("Trade Ready");
  });

  it("renders BSC chain errors and token preflight/quote actions", async () => {
    const errorCtx = createContext({
      inventoryChainFocus: "bsc",
      walletBalances: createWalletBalances("0.006", "BSC RPC timeout"),
    });
    mockUseApp.mockImplementation(() => errorCtx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const content = text(tree?.root);
    expect(content).toContain("BSC: BSC RPC timeout");

    const normalCtx = createContext({
      inventoryChainFocus: "bsc",
      walletBalances: createWalletBalances("0.006", null),
    });
    mockUseApp.mockImplementation(() => normalCtx);
    await act(async () => {
      tree?.update(React.createElement(InventoryView));
    });

    const preflightButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-token-preflight",
    )[0];
    const tokenInput = tree?.root.findAll(
      (node) =>
        node.type === "input" &&
        node.props["data-testid"] === "wallet-quick-token-input",
    )[0];
    const quoteButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-token-quote",
    )[0];
    expect(preflightButton).toBeDefined();
    expect(tokenInput).toBeDefined();
    expect(quoteButton).toBeDefined();

    await act(async () => {
      tokenInput.props.onChange({
        target: { value: "0x1234567890abcdef1234567890abcdef12345678" },
      });
      await flushAsync();
    });

    await act(async () => {
      preflightButton.props.onClick();
      quoteButton.props.onClick();
      await flushAsync();
    });
    expect(normalCtx.getBscTradePreflight).toHaveBeenCalled();
    expect(normalCtx.getBscTradeQuote).toHaveBeenCalled();
  });

  it("keeps the all-chains view free of BSC-only RPC warnings", async () => {
    const balances = createWalletBalances("0.006", null);
    balances.evm.chains = balances.evm.chains.filter(
      (chain) => chain.chain !== "BSC",
    );
    const ctx = createContext({
      elizaCloudConnected: false,
      walletBalances: balances,
      walletConfig: {
        ...createWalletConfig(),
        ankrKeySet: false,
        managedBscRpcReady: false,
        bscBalanceReady: false,
      },
    });
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const content = text(tree?.root);
    expect(content).not.toContain("portfolioheader.ConnectViaElizaCl");
  });

  it("shows managed RPC setup guidance when BSC is focused and unavailable", async () => {
    const balances = createWalletBalances("0.006", null);
    balances.evm.chains = balances.evm.chains.filter(
      (chain) => chain.chain !== "BSC",
    );
    const ctx = createContext({
      inventoryChainFocus: "bsc",
      elizaCloudConnected: false,
      walletBalances: balances,
      walletConfig: {
        ...createWalletConfig(),
        alchemyKeySet: false,
        ankrKeySet: false,
        infuraKeySet: false,
        nodeRealBscRpcSet: false,
        quickNodeBscRpcSet: false,
        managedBscRpcReady: false,
        cloudManagedAccess: false,
        bscBalanceReady: false,
      },
    });
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const content = text(tree?.root);
    expect(content).toContain("portfolioheader.ConnectViaElizaCl");
  });

  it("supports quick trade input and preset actions", async () => {
    const ctx = createContext({
      inventoryChainFocus: "bsc",
      walletBalances: createWalletBalances("0.006", null),
    });
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const tokenInput = tree?.root.findAll(
      (node) =>
        node.type === "input" &&
        node.props["data-testid"] === "wallet-quick-token-input",
    )[0];
    expect(tokenInput).toBeDefined();

    await act(async () => {
      tokenInput.props.onChange({
        target: { value: "0x1234567890abcdef1234567890abcdef12345678" },
      });
    });

    const amountPreset = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quick-amount-0.2",
    )[0];
    const quickBuy = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quick-buy",
    )[0];
    const quickSell = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quick-sell",
    )[0];
    expect(amountPreset).toBeDefined();
    expect(quickBuy).toBeDefined();
    expect(quickSell).toBeDefined();

    await act(async () => {
      amountPreset.props.onClick();
      quickBuy.props.onClick();
      await flushAsync();
    });

    expect(ctx.getBscTradeQuote).toHaveBeenCalled();
    const content = text(tree?.root);
    expect(content).toContain("bsctradepanel.LatestQuote");

    await act(async () => {
      quickSell.props.onClick();
      await flushAsync();
    });
    expect(ctx.getBscTradeQuote).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell" }),
    );
  });

  it("supports manually adding a token contract to wallet rows", async () => {
    const ctx = createContext({
      inventoryChainFocus: "bsc",
      walletBalances: createWalletBalances("0.006", null),
    });
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const tokenInput = tree?.root.findAll(
      (node) =>
        node.type === "input" &&
        node.props["data-testid"] === "wallet-quick-token-input",
    )[0];
    const addButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quick-add-token",
    )[0];
    expect(addButton).toBeDefined();

    await act(async () => {
      tokenInput.props.onChange({
        target: { value: "0x1111111111111111111111111111111111111112" },
      });
      await flushAsync();
    });

    const addButtonUpdated = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quick-add-token",
    )[0];

    await act(async () => {
      addButtonUpdated.props.onClick();
      await flushAsync();
    });

    expect(ctx.setActionNotice).toHaveBeenCalledWith(
      "Token added to watchlist.",
      "success",
      2600,
    );
    expect(text(tree?.root)).toContain("TKN-1111");

    const untrackButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-token-untrack",
    )[0];
    expect(untrackButton).toBeDefined();

    await act(async () => {
      untrackButton.props.onClick();
      await flushAsync();
    });

    expect(text(tree?.root)).not.toContain("TKN-1111");
  });

  it("executes latest quote via inline confirmation", async () => {
    const ctx = createContext({
      inventoryChainFocus: "bsc",
      walletBalances: createWalletBalances("0.02", null),
    });
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const tokenInput = tree?.root.findAll(
      (node) =>
        node.type === "input" &&
        node.props["data-testid"] === "wallet-quick-token-input",
    )[0];
    await act(async () => {
      tokenInput.props.onChange({
        target: { value: "0x1234567890abcdef1234567890abcdef12345678" },
      });
    });

    const quickBuy = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quick-buy",
    )[0];
    await act(async () => {
      quickBuy.props.onClick();
      await flushAsync();
    });

    // Click Execute Trade to show inline confirmation
    const executeButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quote-execute",
    )[0];
    await act(async () => {
      executeButton.props.onClick();
      await flushAsync();
    });

    const confirmButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quote-confirm",
    )[0];
    expect(confirmButton).toBeDefined();
    const cancelButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quote-cancel",
    )[0];
    expect(cancelButton).toBeDefined();

    // Click the Confirm button
    await act(async () => {
      confirmButton.props.onClick();
      await flushAsync();
    });

    expect(ctx.executeBscTrade).toHaveBeenCalledTimes(1);
    expect(text(tree?.root)).toContain("bsctradepanel.ViewTx 0xaaaaaaaa");
  });

  it("shows two-step notice for sell in user-sign mode", async () => {
    const ctx = createContext({
      inventoryChainFocus: "bsc",
      walletBalances: createWalletBalances("0.02", null),
    });
    ctx.executeBscTrade = vi.fn(async () =>
      createExecuteResult(false, { side: "sell", requiresApproval: true }),
    );
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const tokenInput = tree?.root.findAll(
      (node) =>
        node.type === "input" &&
        node.props["data-testid"] === "wallet-quick-token-input",
    )[0];
    await act(async () => {
      tokenInput.props.onChange({
        target: { value: "0x1234567890abcdef1234567890abcdef12345678" },
      });
    });

    const quickSell = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quick-sell",
    )[0];
    await act(async () => {
      quickSell.props.onClick();
      await flushAsync();
    });

    // Click Execute Trade to show inline confirmation
    const executeButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quote-execute",
    )[0];
    await act(async () => {
      executeButton.props.onClick();
      await flushAsync();
    });

    // Click the Confirm button
    const confirmButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quote-confirm",
    )[0];
    expect(confirmButton).toBeDefined();
    await act(async () => {
      confirmButton.props.onClick();
      await flushAsync();
    });

    expect(ctx.executeBscTrade).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell" }),
    );
    expect(ctx.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Sign swap transaction"),
      "info",
      4600,
    );

    const approveCopy = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-copy-approve-tx",
    )[0];
    const swapCopy = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-copy-swap-tx",
    )[0];
    expect(approveCopy).toBeDefined();
    expect(swapCopy).toBeDefined();

    await act(async () => {
      approveCopy.props.onClick();
      swapCopy.props.onClick();
      await flushAsync();
    });
    expect(ctx.copyToClipboard).toHaveBeenCalledTimes(2);
  });

  it("refreshes pending tx status after execute", async () => {
    const ctx = createContext({
      inventoryChainFocus: "bsc",
      walletBalances: createWalletBalances("0.02", null),
    });
    ctx.executeBscTrade = vi.fn(async () =>
      createExecuteResult(true, { executionStatus: "pending" }),
    );
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const tokenInput = tree?.root.findAll(
      (node) =>
        node.type === "input" &&
        node.props["data-testid"] === "wallet-quick-token-input",
    )[0];
    await act(async () => {
      tokenInput.props.onChange({
        target: { value: "0x1234567890abcdef1234567890abcdef12345678" },
      });
    });

    const quickBuy = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quick-buy",
    )[0];
    await act(async () => {
      quickBuy.props.onClick();
      await flushAsync();
    });

    // Click Execute Trade to show inline confirmation
    const executeButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quote-execute",
    )[0];
    await act(async () => {
      executeButton.props.onClick();
      await flushAsync();
    });

    // Click the Confirm button to execute
    const confirmButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-quote-confirm",
    )[0];
    expect(confirmButton).toBeDefined();
    await act(async () => {
      confirmButton.props.onClick();
      await flushAsync();
    });

    const refreshButton = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.props["data-testid"] === "wallet-tx-refresh",
    )[0];
    expect(refreshButton).toBeDefined();

    await act(async () => {
      refreshButton.props.onClick();
      await flushAsync();
    });

    expect(ctx.getBscTradeTxStatus).toHaveBeenCalledWith(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(text(tree?.root)).toContain("bsctradepanel.Confirmations");
  });

  it("shows legacy raw RPC guidance when a focused chain is on legacy config", async () => {
    const ctx = createContext({
      inventoryChainFocus: "bsc",
      walletConfig: {
        ...createWalletConfig(),
        selectedRpcProviders: {
          evm: "alchemy",
          bsc: "nodereal",
          solana: "eliza-cloud",
        },
        legacyCustomChains: ["bsc"],
        bscBalanceReady: true,
      },
    });
    mockUseApp.mockImplementation(() => ctx);

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(InventoryView));
    });

    const content = text(tree?.root);
    expect(content).toContain("BSC is using legacy raw RPC config.");
    expect(content).toContain("Re-save a supported provider in Settings");
  });
});
