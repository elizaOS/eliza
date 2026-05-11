import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_TAB_PRELOAD_SCRIPT } from "../../utils/browser-tabs-renderer-registry";

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const SOLANA_ADDRESS = "FRxMiVKjLwghX4DySdchACz3Gk2bHpv1pW5ydLzK2LQ";

type WalletProtocol = "evm" | "solana";

interface HostWalletRequest {
  type: "__elizaWalletRequest";
  requestId: number;
  protocol: WalletProtocol;
  method: string;
  params: unknown;
  origin: string;
  hostname: string;
}

interface WalletReplyPayload {
  result?: unknown;
  error?: string;
}

interface Eip1193Provider {
  isElizaWallet: boolean;
  selectedAddress: string | null;
  chainId: string;
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on: (event: string, listener: (payload: unknown) => void) => void;
}

interface WalletStandardAccount {
  address: string;
  publicKey: Uint8Array;
  features: string[];
}

interface WalletStandardConnectFeature {
  connect: () => Promise<{ accounts: WalletStandardAccount[] }>;
}

interface WalletStandardSignMessageInput {
  message: Uint8Array;
}

interface WalletStandardSignMessageResult {
  signedMessage: Uint8Array;
  signature: Uint8Array;
  signatureType: string;
}

interface WalletStandardSignMessageFeature {
  signMessage: (
    input: WalletStandardSignMessageInput | WalletStandardSignMessageInput[],
  ) => Promise<WalletStandardSignMessageResult[]>;
}

interface WalletStandardWallet {
  version: string;
  name: string;
  chains: string[];
  accounts: WalletStandardAccount[];
  features: {
    "standard:connect": WalletStandardConnectFeature;
    "solana:signMessage": WalletStandardSignMessageFeature;
    [featureName: string]: unknown;
  };
}

interface SolanaProvider {
  isEliza: boolean;
  isPhantom: boolean;
  publicKey: { toBase58: () => string } | null;
  isConnected: boolean;
}

interface HarnessWindow extends Window {
  __electrobunSendToHost: (payload: HostWalletRequest) => void;
  __elizaWalletReply: (requestId: number, payload: WalletReplyPayload) => void;
  ethereum: Eip1193Provider;
  solana: SolanaProvider;
  phantom: { solana: SolanaProvider };
  eval: (script: string) => unknown;
}

interface WalletStandardRegisterApi {
  register: (wallet: WalletStandardWallet) => void;
}

type WalletStandardRegisterDetail = (api: WalletStandardRegisterApi) => void;

const openDoms: JSDOM[] = [];

afterEach(() => {
  for (const dom of openDoms.splice(0)) {
    dom.window.close();
  }
});

function createWalletPreloadHarness(): {
  hostRequests: HostWalletRequest[];
  registeredWallets: WalletStandardWallet[];
  reply: (request: HostWalletRequest, payload: WalletReplyPayload) => void;
  window: HarnessWindow;
} {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "https://wallet-fixture.local/dapp",
  });
  openDoms.push(dom);

  const hostRequests: HostWalletRequest[] = [];
  const registeredWallets: WalletStandardWallet[] = [];
  const window = dom.window as unknown as HarnessWindow;

  window.__electrobunSendToHost = (payload: HostWalletRequest) => {
    hostRequests.push(payload);
  };
  window.addEventListener("wallet-standard:register-wallet", (event) => {
    const detail = (event as CustomEvent<WalletStandardRegisterDetail>).detail;
    detail({
      register: (wallet) => registeredWallets.push(wallet),
    });
  });

  window.eval(BROWSER_TAB_PRELOAD_SCRIPT);

  return {
    hostRequests,
    registeredWallets,
    reply: (request, payload) =>
      window.__elizaWalletReply(request.requestId, payload),
    window,
  };
}

function expectNoBroadcastRequests(hostRequests: HostWalletRequest[]): void {
  expect(hostRequests.map((request) => request.method)).not.toContain(
    "eth_sendTransaction",
  );
  expect(hostRequests.map((request) => request.method)).not.toContain(
    "signAndSendTransaction",
  );
  for (const request of hostRequests) {
    const params = request.params;
    if (params && typeof params === "object") {
      expect(params).not.toHaveProperty("broadcast");
    }
  }
}

describe("browser workspace wallet preload injection", () => {
  it("installs EIP-1193 and announces EIP-6963 without disclosing accounts", () => {
    const { hostRequests, window } = createWalletPreloadHarness();
    const announcements: unknown[] = [];
    window.addEventListener("eip6963:announceProvider", (event) => {
      announcements.push((event as CustomEvent<unknown>).detail);
    });

    window.dispatchEvent(new window.Event("eip6963:requestProvider"));

    expect(window.ethereum.isElizaWallet).toBe(true);
    expect(window.ethereum.selectedAddress).toBeNull();
    expect(window.ethereum.chainId).toBe("0x1");
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toMatchObject({
      info: {
        name: "Eliza",
        rdns: "ai.eliza.wallet",
      },
      provider: window.ethereum,
    });
    expect(hostRequests).toHaveLength(0);
  });

  it("routes EIP-1193 connect and message signing through host consent only", async () => {
    const { hostRequests, reply, window } = createWalletPreloadHarness();
    const accountsChanged = vi.fn();
    const connect = vi.fn();
    window.ethereum.on("accountsChanged", accountsChanged);
    window.ethereum.on("connect", connect);

    const connectPromise = window.ethereum.request({
      method: "eth_requestAccounts",
    });
    expect(hostRequests[0]).toMatchObject({
      type: "__elizaWalletRequest",
      protocol: "evm",
      method: "eth_requestAccounts",
      params: undefined,
      origin: "https://wallet-fixture.local",
      hostname: "wallet-fixture.local",
    });
    expect(window.ethereum.selectedAddress).toBeNull();

    reply(hostRequests[0], { result: [EVM_ADDRESS] });

    await expect(connectPromise).resolves.toEqual([EVM_ADDRESS]);
    expect(window.ethereum.selectedAddress).toBe(EVM_ADDRESS);
    expect(accountsChanged).toHaveBeenCalledWith([EVM_ADDRESS]);
    expect(connect).toHaveBeenCalledWith({ chainId: "0x1" });

    const signPromise = window.ethereum.request({
      method: "personal_sign",
      params: ["hello", EVM_ADDRESS],
    });
    expect(hostRequests[1]).toMatchObject({
      protocol: "evm",
      method: "personal_sign",
      params: ["hello", EVM_ADDRESS],
    });

    reply(hostRequests[1], { result: "0xsafe-signature" });

    await expect(signPromise).resolves.toBe("0xsafe-signature");
    expectNoBroadcastRequests(hostRequests);
  });

  it("registers Wallet Standard and routes Solana connect/signMessage without broadcasting", async () => {
    const { hostRequests, registeredWallets, reply, window } =
      createWalletPreloadHarness();

    expect(window.solana.isEliza).toBe(true);
    expect(window.solana.isPhantom).toBe(true);
    expect(window.phantom.solana).toBe(window.solana);
    expect(registeredWallets).toHaveLength(1);

    const wallet = registeredWallets[0];
    expect(wallet.name).toBe("Eliza Wallet");
    expect(wallet.features).toMatchObject({
      "standard:connect": expect.any(Object),
      "solana:signMessage": expect.any(Object),
    });

    const connectPromise = wallet.features["standard:connect"].connect();
    expect(hostRequests[0]).toMatchObject({
      type: "__elizaWalletRequest",
      protocol: "solana",
      method: "connect",
      params: null,
      origin: "https://wallet-fixture.local",
      hostname: "wallet-fixture.local",
    });

    reply(hostRequests[0], { result: { publicKey: SOLANA_ADDRESS } });

    const connectResult = await connectPromise;
    expect(connectResult.accounts[0]).toMatchObject({
      address: SOLANA_ADDRESS,
      chains: ["solana:mainnet", "solana:devnet", "solana:testnet"],
      features: expect.arrayContaining(["solana:signMessage"]),
      label: "Eliza Wallet",
    });
    expect(window.solana.publicKey?.toBase58()).toBe(SOLANA_ADDRESS);

    const message = new Uint8Array([104, 105]);
    const signPromise = wallet.features["solana:signMessage"].signMessage({
      message,
    });
    await Promise.resolve();
    expect(hostRequests[1]).toMatchObject({
      protocol: "solana",
      method: "signMessage",
      params: {
        messageBase64: "aGk=",
      },
    });

    reply(hostRequests[1], { result: { signatureBase64: "AQID" } });

    const signResult = await signPromise;
    expect(signResult[0].signatureType).toBe("ed25519");
    expect(Array.from(signResult[0].signedMessage)).toEqual([104, 105]);
    expect(Array.from(signResult[0].signature)).toEqual([1, 2, 3]);
    expectNoBroadcastRequests(hostRequests);
  });
});
