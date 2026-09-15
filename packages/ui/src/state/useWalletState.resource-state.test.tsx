/** Verifies wallet feeds keep independent lifecycle/error state under concurrent requests. */
// @vitest-environment jsdom

import type {
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
} from "@elizaos/shared";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authority: {
    value: "https://agent-a.test",
    profileId: "profile-a",
    revision: 0,
    listeners: new Set<() => void>(),
  },
  client: {
    getBaseUrl: vi.fn(),
    getAuthorityRevision: vi.fn(),
    onAuthorityChange: vi.fn(),
    onBaseUrlChange: vi.fn(),
    updateConfig: vi.fn(async () => undefined),
    getConfig: vi.fn(async () => ({ ui: {} })),
    getWalletConfig: vi.fn(),
    getWalletBalances: vi.fn(),
    getWalletNfts: vi.fn(),
    updateWalletConfig: vi.fn(),
    refreshCloudWallets: vi.fn(),
    setWalletPrimary: vi.fn(),
    generateWallet: vi.fn(),
  },
  persistence: {
    loadWalletEnabled: vi.fn(() => true),
    loadBrowserEnabled: vi.fn(() => false),
    loadComputerUseEnabled: vi.fn(() => false),
    saveWalletEnabled: vi.fn(),
    saveBrowserEnabled: vi.fn(),
    saveComputerUseEnabled: vi.fn(),
  },
}));

vi.mock("../api", () => ({ client: mocks.client }));
vi.mock("../api/client", () => ({ client: mocks.client }));
vi.mock("./agent-profiles", () => ({
  loadAgentProfileRegistry: () => ({
    version: 1,
    activeProfileId: mocks.authority.profileId,
    profiles: [],
  }),
}));
vi.mock("./persistence", () => mocks.persistence);
vi.mock("../utils/desktop-dialogs", () => ({
  confirmDesktopAction: vi.fn(async () => true),
}));

import { ApiError } from "../api/client-types-core";
import { useWalletState } from "./useWalletState";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const EMPTY_NFTS: WalletNftsResponse = { evm: [], solana: null };
const FIRST_BALANCES: WalletBalancesResponse = {
  evm: {
    address: "0xfirst",
    chains: [],
  },
  solana: null,
};
const LATEST_BALANCES: WalletBalancesResponse = {
  evm: {
    address: "0xlatest",
    chains: [],
  },
  solana: null,
};
const AGENT_B_BALANCES: WalletBalancesResponse = {
  evm: {
    address: "0xagentb",
    chains: [],
  },
  solana: null,
};
const FIRST_CONFIG: WalletConfigStatus = {
  evmAddress: "0xfirst",
  solanaAddress: null,
  selectedRpcProviders: {
    evm: "alchemy",
    bsc: "alchemy",
    solana: "helius-birdeye",
  },
  legacyCustomChains: [],
  alchemyKeySet: true,
  infuraKeySet: false,
  ankrKeySet: false,
  heliusKeySet: true,
  birdeyeKeySet: true,
  evmChains: ["ethereum"],
  wallets: [
    {
      source: "local",
      chain: "evm",
      address: "0xfirst",
      provider: "local",
      primary: true,
    },
  ],
  primary: { evm: "local", solana: "local" },
};
const LATEST_CONFIG: WalletConfigStatus = {
  ...FIRST_CONFIG,
  evmAddress: "0xlatest",
  wallets: [
    {
      source: "local",
      chain: "evm",
      address: "0xlatest",
      provider: "local",
      primary: true,
    },
  ],
};
const AGENT_B_CONFIG: WalletConfigStatus = {
  ...LATEST_CONFIG,
  evmAddress: "0xagentb",
  wallets: [
    {
      source: "local",
      chain: "evm",
      address: "0xagentb",
      provider: "local",
      primary: true,
    },
  ],
};

function renderWalletState() {
  return renderHook(() =>
    useWalletState({
      setActionNotice: vi.fn(),
      promptModal: vi.fn(async () => null),
      agentName: undefined,
      characterName: undefined,
      hydrateServerConfig: false,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authority.value = "https://agent-a.test";
  mocks.authority.profileId = "profile-a";
  mocks.authority.revision = 0;
  mocks.authority.listeners.clear();
  mocks.client.getBaseUrl.mockImplementation(() => mocks.authority.value);
  mocks.client.getAuthorityRevision.mockImplementation(
    () => mocks.authority.revision,
  );
  mocks.client.onAuthorityChange.mockImplementation((onChange: () => void) => {
    mocks.authority.listeners.add(onChange);
    return () => mocks.authority.listeners.delete(onChange);
  });
  for (const mock of [
    mocks.client.getWalletConfig,
    mocks.client.getWalletBalances,
    mocks.client.getWalletNfts,
    mocks.client.updateWalletConfig,
    mocks.client.refreshCloudWallets,
    mocks.client.setWalletPrimary,
    mocks.client.generateWallet,
  ]) {
    mock.mockReset();
  }
  mocks.client.getWalletBalances.mockResolvedValue(LATEST_BALANCES);
  mocks.client.updateWalletConfig.mockResolvedValue({ ok: true });
  mocks.client.refreshCloudWallets.mockResolvedValue({ ok: true });
  mocks.client.setWalletPrimary.mockResolvedValue({ ok: true });
});

describe("useWalletState resource lifecycle", () => {
  it("hides the prior wallet and drops stale responses for a same-host profile switch", async () => {
    mocks.client.getWalletConfig.mockResolvedValueOnce(FIRST_CONFIG);
    mocks.client.getWalletBalances.mockResolvedValueOnce(FIRST_BALANCES);
    const { result } = renderWalletState();

    await act(async () => {
      await Promise.all([
        result.current.loadWalletConfig(),
        result.current.loadBalances(),
      ]);
    });
    expect(result.current.state.walletConfig).toEqual(FIRST_CONFIG);
    expect(result.current.state.walletBalances).toEqual(FIRST_BALANCES);

    const staleConfig = deferred<WalletConfigStatus>();
    const staleBalances = deferred<WalletBalancesResponse>();
    mocks.client.getWalletConfig.mockReturnValueOnce(staleConfig.promise);
    mocks.client.getWalletBalances.mockReturnValueOnce(staleBalances.promise);
    let staleConfigLoad!: Promise<void>;
    let staleBalanceLoad!: Promise<void>;
    await act(async () => {
      staleConfigLoad = result.current.loadWalletConfig();
      staleBalanceLoad = result.current.loadBalances();
      await Promise.resolve();
    });

    act(() => {
      mocks.authority.profileId = "profile-b";
      for (const onChange of mocks.authority.listeners) onChange();
    });

    // The authority-associated return state fail-closes in the switch render;
    // it does not wait for the passive reset effect or B's network response.
    expect(result.current.state.walletConfig).toBeNull();
    expect(result.current.state.walletAddresses).toBeNull();
    expect(result.current.state.walletBalances).toBeNull();
    expect(result.current.state.walletConfigStatus).toBe("idle");
    expect(result.current.state.walletBalancesStatus).toBe("idle");

    await act(async () => {
      staleConfig.resolve(LATEST_CONFIG);
      staleBalances.resolve(LATEST_BALANCES);
      await Promise.all([staleConfigLoad, staleBalanceLoad]);
    });
    expect(result.current.state.walletConfig).toBeNull();
    expect(result.current.state.walletBalances).toBeNull();

    mocks.client.getWalletConfig.mockResolvedValueOnce(AGENT_B_CONFIG);
    mocks.client.getWalletBalances.mockResolvedValueOnce(AGENT_B_BALANCES);
    await act(async () => {
      await Promise.all([
        result.current.loadWalletConfig(),
        result.current.loadBalances(),
      ]);
    });
    expect(result.current.state.walletConfig).toEqual(AGENT_B_CONFIG);
    expect(result.current.state.walletBalances).toEqual(AGENT_B_BALANCES);
  });

  it("hides wallet data and rejects late work after a same-host credential change", async () => {
    mocks.client.getWalletConfig.mockResolvedValueOnce(FIRST_CONFIG);
    mocks.client.getWalletBalances.mockResolvedValueOnce(FIRST_BALANCES);
    const { result } = renderWalletState();

    await act(async () => {
      await Promise.all([
        result.current.loadWalletConfig(),
        result.current.loadBalances(),
      ]);
    });
    expect(result.current.state.walletConfig).toEqual(FIRST_CONFIG);
    expect(result.current.state.walletBalances).toEqual(FIRST_BALANCES);

    const staleConfig = deferred<WalletConfigStatus>();
    mocks.client.getWalletConfig.mockReturnValueOnce(staleConfig.promise);
    let staleLoad!: Promise<void>;
    await act(async () => {
      staleLoad = result.current.loadWalletConfig();
      await Promise.resolve();
    });

    act(() => {
      mocks.authority.revision += 1;
      for (const onChange of mocks.authority.listeners) onChange();
    });

    expect(mocks.authority.profileId).toBe("profile-a");
    expect(mocks.authority.value).toBe("https://agent-a.test");
    expect(result.current.state.walletConfig).toBeNull();
    expect(result.current.state.walletAddresses).toBeNull();
    expect(result.current.state.walletBalances).toBeNull();

    await act(async () => {
      staleConfig.resolve(LATEST_CONFIG);
      await staleLoad;
    });
    expect(result.current.state.walletConfig).toBeNull();
    expect(result.current.state.walletAddresses).toBeNull();
  });

  it("stops a wallet mutation when its initiating authority is superseded", async () => {
    const update = deferred<unknown>();
    mocks.client.updateWalletConfig.mockReturnValueOnce(update.promise);
    const { result } = renderWalletState();

    let save!: Promise<boolean>;
    await act(async () => {
      save = result.current.handleWalletApiKeySave({
        selections: LATEST_CONFIG.selectedRpcProviders,
      });
      await Promise.resolve();
    });

    act(() => {
      mocks.authority.value = "https://agent-b.test";
      for (const onChange of mocks.authority.listeners) onChange();
    });
    await act(async () => {
      update.resolve({ ok: true });
      expect(await save).toBe(false);
    });

    expect(mocks.client.getWalletConfig).not.toHaveBeenCalled();
    expect(mocks.client.getWalletBalances).not.toHaveBeenCalled();
    expect(result.current.state.walletError).toBeNull();
  });

  it("clears a config error and returns to ready after a successful settings save", async () => {
    mocks.client.getWalletConfig.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderWalletState();

    await act(async () => {
      await result.current.loadWalletConfig();
    });
    expect(result.current.state.walletConfigStatus).toBe("error");
    expect(result.current.state.walletConfigError).toContain("offline");

    mocks.client.getWalletConfig.mockResolvedValueOnce(LATEST_CONFIG);
    let saved = false;
    await act(async () => {
      saved = await result.current.handleWalletApiKeySave({
        selections: LATEST_CONFIG.selectedRpcProviders,
      });
    });

    expect(saved).toBe(true);
    expect(result.current.state.walletConfig).toEqual(LATEST_CONFIG);
    expect(result.current.state.walletConfigStatus).toBe("ready");
    expect(result.current.state.walletConfigError).toBeNull();
  });

  it("runs cloud refresh and primary selection through the same config lifecycle", async () => {
    mocks.client.getWalletConfig.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderWalletState();

    await act(async () => {
      await result.current.loadWalletConfig();
    });
    expect(result.current.state.walletConfigStatus).toBe("error");

    mocks.client.getWalletConfig.mockResolvedValueOnce(FIRST_CONFIG);
    await act(async () => {
      await result.current.refreshCloudWallets();
    });
    expect(result.current.state.walletConfigStatus).toBe("ready");
    expect(result.current.state.walletConfigError).toBeNull();
    expect(result.current.state.walletConfig).toEqual(FIRST_CONFIG);

    mocks.client.getWalletConfig.mockResolvedValueOnce(LATEST_CONFIG);
    await act(async () => {
      await result.current.setWalletPrimary("evm", "local");
    });
    expect(mocks.client.setWalletPrimary).toHaveBeenCalledWith({
      chain: "evm",
      source: "local",
    });
    expect(result.current.state.walletConfig).toEqual(LATEST_CONFIG);
    expect(result.current.state.walletConfigStatus).toBe("ready");
    expect(result.current.state.walletConfigError).toBeNull();
  });

  it("does not let an older config response overwrite a newer request", async () => {
    const first = deferred<WalletConfigStatus>();
    const latest = deferred<WalletConfigStatus>();
    mocks.client.getWalletConfig
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const { result } = renderWalletState();

    let firstLoad!: Promise<void>;
    let latestLoad!: Promise<void>;
    await act(async () => {
      firstLoad = result.current.loadWalletConfig();
      latestLoad = result.current.loadWalletConfig();
      await Promise.resolve();
    });
    await act(async () => {
      latest.resolve(LATEST_CONFIG);
      await latestLoad;
    });
    await act(async () => {
      first.resolve(FIRST_CONFIG);
      await firstLoad;
    });

    expect(result.current.state.walletConfig).toEqual(LATEST_CONFIG);
    expect(result.current.state.walletConfigStatus).toBe("ready");
    expect(result.current.state.walletConfigError).toBeNull();
  });

  it("does not let a later NFT success clear an earlier balance failure", async () => {
    const balances = deferred<WalletBalancesResponse>();
    const nfts = deferred<WalletNftsResponse>();
    mocks.client.getWalletBalances.mockReturnValueOnce(balances.promise);
    mocks.client.getWalletNfts.mockReturnValueOnce(nfts.promise);
    const { result } = renderWalletState();

    let balanceLoad!: Promise<void>;
    let nftLoad!: Promise<void>;
    await act(async () => {
      balanceLoad = result.current.loadBalances();
      nftLoad = result.current.loadNfts();
      await Promise.resolve();
    });

    await act(async () => {
      balances.reject(new Error("RPC offline"));
      await balanceLoad;
    });
    expect(result.current.state.walletBalancesStatus).toBe("error");
    expect(result.current.state.walletBalancesError).toContain("RPC offline");

    await act(async () => {
      nfts.resolve(EMPTY_NFTS);
      await nftLoad;
    });
    expect(result.current.state.walletNftsStatus).toBe("ready");
    expect(result.current.state.walletBalancesStatus).toBe("error");
    expect(result.current.state.walletBalancesError).toContain("RPC offline");
    expect(result.current.state.walletError).toBeNull();
  });

  it("ignores a stale balance failure that arrives after a newer success", async () => {
    const first = deferred<WalletBalancesResponse>();
    const latest = deferred<WalletBalancesResponse>();
    mocks.client.getWalletBalances
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const { result } = renderWalletState();

    let firstLoad!: Promise<void>;
    let latestLoad!: Promise<void>;
    await act(async () => {
      firstLoad = result.current.loadBalances();
      latestLoad = result.current.loadBalances();
      await Promise.resolve();
    });
    await act(async () => {
      latest.resolve(LATEST_BALANCES);
      await latestLoad;
    });
    await act(async () => {
      first.reject(new Error("stale failure"));
      await firstLoad;
    });

    expect(result.current.state.walletBalances).toEqual(LATEST_BALANCES);
    expect(result.current.state.walletBalancesStatus).toBe("ready");
    expect(result.current.state.walletBalancesError).toBeNull();
    expect(result.current.state.walletLoading).toBe(false);
    expect(result.current.state.walletBalances).not.toEqual(FIRST_BALANCES);
  });

  it("classifies an unsupported NFT endpoint without faking an empty response", async () => {
    mocks.client.getWalletNfts.mockRejectedValueOnce(
      new ApiError({
        kind: "http",
        path: "/api/wallet/nfts",
        status: 501,
        code: "wallet_nfts_unavailable",
        message: "NFT inventory unavailable",
      }),
    );
    const { result } = renderWalletState();

    await act(async () => {
      await result.current.loadNfts();
    });

    expect(result.current.state.walletNfts).toBeNull();
    expect(result.current.state.walletNftsStatus).toBe("unavailable");
    expect(result.current.state.walletNftsError).toBeNull();
    expect(result.current.state.walletError).toBeNull();
  });
});
