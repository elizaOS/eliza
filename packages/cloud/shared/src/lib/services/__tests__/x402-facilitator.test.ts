// Exercises x402 facilitator behavior with deterministic cloud-shared lib fixtures.
import { expect, mock, test } from "bun:test";

const NETWORK = "eip155:8453";
const ASSET = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";
const FACILITATOR = "0x4444444444444444444444444444444444444444";
const SIGNATURE = "0xdeadbeef";
const NONCE = "0x0000000000000000000000000000000000000000000000000000000000000001";
const TX_HASH = "0xabc123";

const writeContract = mock(async () => TX_HASH);
const waitForTransactionReceipt = mock(async () => ({
  status: "success",
  logs: [],
}));
const parseEventLogs = mock(() => [
  {
    address: ASSET,
    args: {
      from: PAYER,
      to: PAY_TO,
      value: 100n,
    },
  },
]);
const getSecret = mock(async () => null as string | null);

mock.module("@solana/kit", () => ({
  createKeyPairSignerFromBytes: mock(() => ({ address: "solana-signer" })),
}));

mock.module("@x402/svm", () => ({
  createRpcClient: mock(() => ({})),
  SOLANA_DEVNET_CAIP2: "solana:devnet",
  SOLANA_MAINNET_CAIP2: "solana:mainnet",
  SOLANA_TESTNET_CAIP2: "solana:testnet",
  toFacilitatorSvmSigner: mock((signer) => signer),
  USDC_DEVNET_ADDRESS: "solana-usdc-devnet",
  USDC_MAINNET_ADDRESS: "solana-usdc-mainnet",
  USDC_TESTNET_ADDRESS: "solana-usdc-testnet",
}));

mock.module("@x402/svm/exact/facilitator", () => ({
  ExactSvmScheme: class ExactSvmScheme {
    getExtra() {
      return {};
    }
    getSigners() {
      return [];
    }
    async verify() {
      return { isValid: false, invalidReason: "mocked" };
    }
    async settle() {
      return { success: false, errorReason: "mocked" };
    }
  },
}));

mock.module("bs58", () => ({
  default: {
    decode: mock(() => new Uint8Array(64)),
  },
}));

mock.module("viem", () => ({
  createPublicClient: mock(() => ({})),
  createWalletClient: mock(() => ({ writeContract })),
  http: mock(() => ({})),
  parseAbiItem: mock((signature: string) => signature),
  parseEventLogs,
}));

mock.module("viem/accounts", () => ({
  privateKeyToAccount: mock(() => ({ address: FACILITATOR })),
}));

mock.module("viem/chains", () => ({
  base: {},
  baseSepolia: {},
  bsc: {},
  bscTestnet: {},
  mainnet: {},
  sepolia: {},
}));

mock.module("../secrets", () => ({
  secretsService: {
    get: getSecret,
  },
}));

const { x402FacilitatorService } = await import("../x402-facilitator");

type MutableFacilitator = {
  initialize: () => Promise<void>;
  initialized: boolean;
  account: { address: string } | null;
  enabledNetworks: string[];
  networks: Record<string, { chainId: number; usdcAddress: string; usdcDomainName: string }>;
  clients: Map<
    string,
    {
      verifyTypedData: ReturnType<typeof mock>;
      readContract: ReturnType<typeof mock>;
      waitForTransactionReceipt?: ReturnType<typeof mock>;
    }
  >;
};

function resetFacilitatorInitialization(): MutableFacilitator & {
  initializing: Promise<void> | null;
} {
  const service = x402FacilitatorService as unknown as MutableFacilitator & {
    initializing: Promise<void> | null;
    svmScheme: unknown;
    enabledSolanaNetworks: string[];
    solanaNetworks: Record<string, unknown>;
  };
  service.initialized = false;
  service.initializing = null;
  service.account = null;
  service.enabledNetworks = [];
  service.clients = new Map();
  service.networks = {};
  service.svmScheme = null;
  service.enabledSolanaNetworks = [];
  service.solanaNetworks = {};
  return service;
}

function paymentPayload(authorizationValue: string) {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: NETWORK,
      asset: ASSET,
      amount: "100",
      payTo: PAY_TO,
    },
    payload: {
      signature: SIGNATURE,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: authorizationValue,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: NONCE,
      },
    },
  };
}

const requirements = {
  scheme: "exact",
  network: NETWORK,
  asset: ASSET,
  amount: "100",
  payTo: PAY_TO,
};

// The facilitator sponsors gas, so it only settles to a platform-owned payTo:
// the configured recipient env or its own signer address. Configure PAY_TO as
// the platform recipient here so the legitimate settle tests below pass the
// guard; the attacker test uses a DIFFERENT payTo that is not platform-owned.
process.env.X402_RECIPIENT_ADDRESS = PAY_TO;

test("initialize fails closed when the EVM facilitator secret read fails", async () => {
  const previousNetworks = process.env.X402_NETWORKS;
  const previousFacilitatorKey = process.env.FACILITATOR_PRIVATE_KEY;
  const previousX402FacilitatorKey = process.env.X402_FACILITATOR_PRIVATE_KEY;
  resetFacilitatorInitialization();
  getSecret.mockReset();
  getSecret.mockRejectedValue(new Error("secrets store unavailable"));
  process.env.X402_NETWORKS = "base";
  process.env.FACILITATOR_PRIVATE_KEY =
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.X402_FACILITATOR_PRIVATE_KEY;

  try {
    await expect(x402FacilitatorService.initialize()).rejects.toMatchObject({
      message: "[x402-facilitator] Failed to read FACILITATOR_PRIVATE_KEY from secrets service",
      cause: expect.objectContaining({ message: "secrets store unavailable" }),
    });
    expect(getSecret).toHaveBeenCalledWith("system", "FACILITATOR_PRIVATE_KEY");
  } finally {
    resetFacilitatorInitialization();
    getSecret.mockReset();
    getSecret.mockResolvedValue(null);
    if (previousNetworks === undefined) delete process.env.X402_NETWORKS;
    else process.env.X402_NETWORKS = previousNetworks;
    if (previousFacilitatorKey === undefined) delete process.env.FACILITATOR_PRIVATE_KEY;
    else process.env.FACILITATOR_PRIVATE_KEY = previousFacilitatorKey;
    if (previousX402FacilitatorKey === undefined) delete process.env.X402_FACILITATOR_PRIVATE_KEY;
    else process.env.X402_FACILITATOR_PRIVATE_KEY = previousX402FacilitatorKey;
  }
});

test("initialize fails closed when the Solana facilitator secret read fails", async () => {
  const previousNetworks = process.env.X402_NETWORKS;
  const previousSolanaKey = process.env.X402_SOLANA_FACILITATOR_PRIVATE_KEY;
  resetFacilitatorInitialization();
  getSecret.mockReset();
  getSecret.mockImplementation(async (_scope, keyName) => {
    if (keyName === "FACILITATOR_PRIVATE_KEY") return null;
    throw new Error("solana secret read failed");
  });
  process.env.X402_NETWORKS = "solana-devnet";
  process.env.X402_SOLANA_FACILITATOR_PRIVATE_KEY = `[${Array.from(
    { length: 64 },
    (_, i) => i,
  ).join(",")}]`;

  try {
    await expect(x402FacilitatorService.initialize()).rejects.toMatchObject({
      message:
        "[x402-facilitator] Failed to read X402_SOLANA_FACILITATOR_PRIVATE_KEY from secrets service",
      cause: expect.objectContaining({ message: "solana secret read failed" }),
    });
    expect(getSecret).toHaveBeenCalledWith("system", "X402_SOLANA_FACILITATOR_PRIVATE_KEY");
  } finally {
    resetFacilitatorInitialization();
    getSecret.mockReset();
    getSecret.mockResolvedValue(null);
    if (previousNetworks === undefined) delete process.env.X402_NETWORKS;
    else process.env.X402_NETWORKS = previousNetworks;
    if (previousSolanaKey === undefined) delete process.env.X402_SOLANA_FACILITATOR_PRIVATE_KEY;
    else process.env.X402_SOLANA_FACILITATOR_PRIVATE_KEY = previousSolanaKey;
  }
});

function primeEvmFacilitator() {
  process.env.X402_RECIPIENT_ADDRESS = PAY_TO;
  writeContract.mockClear();
  writeContract.mockResolvedValue(TX_HASH);
  waitForTransactionReceipt.mockClear();
  waitForTransactionReceipt.mockResolvedValue({
    status: "success",
    logs: [],
  });
  parseEventLogs.mockClear();
  parseEventLogs.mockReturnValue([
    {
      address: ASSET,
      args: {
        from: PAYER,
        to: PAY_TO,
        value: 100n,
      },
    },
  ]);

  const verifyTypedData = mock(async () => true);
  const readContract = mock(async () => 100n);
  const service = x402FacilitatorService as unknown as MutableFacilitator;
  service.initialize = mock(async () => undefined);
  service.initialized = true;
  service.account = { address: FACILITATOR };
  service.enabledNetworks = [NETWORK];
  service.networks = {
    [NETWORK]: {
      chainId: 8453,
      usdcAddress: ASSET,
      usdcDomainName: "USDC",
      rpcUrl: "https://rpc.example",
      chain: {},
    },
  };
  service.clients = new Map([
    [NETWORK, { verifyTypedData, readContract, waitForTransactionReceipt }],
  ]);
  return { verifyTypedData, readContract };
}

test("verify rejects when signed authorization.value is below the required amount", async () => {
  const { verifyTypedData, readContract } = primeEvmFacilitator();

  const result = await x402FacilitatorService.verify(paymentPayload("1"), requirements);

  expect(result).toEqual({
    isValid: false,
    invalidReason: "insufficient_amount",
    payer: PAYER,
  });
  expect(verifyTypedData).not.toHaveBeenCalled();
  expect(readContract).not.toHaveBeenCalled();
});

test("verify accepts matching signed authorization.value and continues to signature/balance checks", async () => {
  const { verifyTypedData, readContract } = primeEvmFacilitator();

  const result = await x402FacilitatorService.verify(paymentPayload("100"), requirements);

  expect(result).toEqual({ isValid: true, payer: PAYER });
  expect(verifyTypedData).toHaveBeenCalledTimes(1);
  expect(readContract).toHaveBeenCalledTimes(1);
});

test("settle rejects when the submitted EVM transaction reverts before crediting", async () => {
  primeEvmFacilitator();
  waitForTransactionReceipt.mockResolvedValue({
    status: "reverted",
    logs: [],
  });

  const result = await x402FacilitatorService.settle(paymentPayload("100"), requirements);

  expect(result).toEqual({
    success: false,
    transaction: "",
    network: NETWORK,
    payer: PAYER,
    errorReason: "settlement_reverted",
  });
  expect(writeContract).toHaveBeenCalledTimes(1);
  expect(waitForTransactionReceipt).toHaveBeenCalledWith({
    hash: TX_HASH,
    timeout: 300_000,
  });
});

test("settle rejects when the receipt does not contain the required token transfer", async () => {
  primeEvmFacilitator();
  parseEventLogs.mockReturnValue([
    {
      address: ASSET,
      args: {
        from: PAYER,
        to: PAY_TO,
        value: 1n,
      },
    },
  ]);

  const result = await x402FacilitatorService.settle(paymentPayload("100"), requirements);

  expect(result).toEqual({
    success: false,
    transaction: "",
    network: NETWORK,
    payer: PAYER,
    errorReason: "settlement_amount_too_low",
  });
  expect(writeContract).toHaveBeenCalledTimes(1);
  expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
});

test("settle succeeds only after the EVM receipt proves the required transfer", async () => {
  primeEvmFacilitator();

  const result = await x402FacilitatorService.settle(paymentPayload("100"), requirements);

  expect(result).toEqual({
    success: true,
    transaction: TX_HASH,
    network: NETWORK,
    payer: PAYER,
  });
  expect(writeContract).toHaveBeenCalledTimes(1);
  expect(waitForTransactionReceipt).toHaveBeenCalledWith({
    hash: TX_HASH,
    timeout: 300_000,
  });
  expect(parseEventLogs).toHaveBeenCalledTimes(1);
});

// #11574: gas-drain via the unauthenticated /api/v1/x402/settle route. An
// attacker relays their OWN valid EIP-3009 transfer — their funds, their
// recipient, a self-consistent payTo (authorization.to === requirements.payTo)
// so verify() passes — and the platform would sponsor the gas for free. The
// payTo binding must reject it BEFORE any on-chain write / gas spend.
const ATTACKER_PAY_TO = "0x9999999999999999999999999999999999999999";

function attackerPaymentPayload() {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: NETWORK,
      asset: ASSET,
      amount: "100",
      payTo: ATTACKER_PAY_TO,
    },
    payload: {
      signature: SIGNATURE,
      authorization: {
        from: PAYER,
        to: ATTACKER_PAY_TO,
        value: "100",
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: NONCE,
      },
    },
  };
}

const attackerRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: ASSET,
  amount: "100",
  payTo: ATTACKER_PAY_TO,
};

test("settle rejects a non-platform payTo without spending gas (writeContract never called)", async () => {
  const { verifyTypedData, readContract } = primeEvmFacilitator();

  const result = await x402FacilitatorService.settle(
    attackerPaymentPayload(),
    attackerRequirements,
  );

  expect(result).toEqual({
    success: false,
    transaction: "",
    network: NETWORK,
    errorReason: "payto_not_platform_owned",
  });
  // The whole point: the platform gas wallet is never touched.
  expect(writeContract).not.toHaveBeenCalled();
  expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  // Rejected up front — no verification / RPC work either.
  expect(verifyTypedData).not.toHaveBeenCalled();
  expect(readContract).not.toHaveBeenCalled();
});

test("settle to the facilitator's own signer address is allowed and reaches writeContract", async () => {
  primeEvmFacilitator();
  // No configured recipient env → the platform allowlist falls back to the
  // facilitator's own signer address (mirrors resolvePaymentRecipient()).
  delete process.env.X402_RECIPIENT_ADDRESS;

  const signerPayload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: NETWORK,
      asset: ASSET,
      amount: "100",
      payTo: FACILITATOR,
    },
    payload: {
      signature: SIGNATURE,
      authorization: {
        from: PAYER,
        to: FACILITATOR,
        value: "100",
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: NONCE,
      },
    },
  };
  parseEventLogs.mockReturnValue([
    { address: ASSET, args: { from: PAYER, to: FACILITATOR, value: 100n } },
  ]);

  const result = await x402FacilitatorService.settle(signerPayload, {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: "100",
    payTo: FACILITATOR,
  });

  expect(result).toEqual({
    success: true,
    transaction: TX_HASH,
    network: NETWORK,
    payer: PAYER,
  });
  expect(writeContract).toHaveBeenCalledTimes(1);
});
