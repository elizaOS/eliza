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

// W5-001: resolved (not thrown) facilitator results reach unauthenticated
// callers verbatim via the /api/v1/x402 routes, so raw upstream error text —
// viem's HttpRequestError embeds `URL: https://…/v2/<key>` with the platform's
// ALCHEMY/INFURA key, and @x402/svm returns raw thrown messages as
// `invalidReason` on decode/simulate failure — must never appear in them.
// Service catches collapse to constant reason codes and the @x402/svm
// passthrough only allows constant-shaped codes.
const SOLANA_NETWORK = "solana:mainnet";
const LEAKY_MESSAGE =
  "HTTP request failed. URL: https://base-mainnet.g.alchemy.com/v2/ALCHEMYKEY123 Status: 401";

function solanaPaymentPayload() {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: SOLANA_NETWORK,
      asset: ASSET,
      amount: "100",
      payTo: PAY_TO,
    },
    payload: { transaction: "deadbeef" },
  };
}

const solanaRequirements = {
  scheme: "exact",
  network: SOLANA_NETWORK,
  asset: ASSET,
  amount: "100",
  payTo: PAY_TO,
};

function primeSolanaFacilitator(svmScheme: {
  verify: unknown;
  settle: unknown;
  getSigners?: unknown;
}) {
  process.env.X402_SOLANA_RECIPIENT_ADDRESS = PAY_TO;
  const service = x402FacilitatorService as unknown as MutableFacilitator & {
    svmScheme: unknown;
    enabledSolanaNetworks: string[];
  };
  service.initialize = mock(async () => undefined);
  service.initialized = true;
  service.account = null;
  service.svmScheme = { getSigners: () => [], ...svmScheme };
  service.enabledSolanaNetworks = [SOLANA_NETWORK];
  return service;
}

test("verify collapses an EVM signature-check throw to a constant reason", async () => {
  const { verifyTypedData, readContract } = primeEvmFacilitator();
  verifyTypedData.mockRejectedValue(new Error(LEAKY_MESSAGE));

  const result = await x402FacilitatorService.verify(paymentPayload("100"), requirements);

  expect(result).toEqual({
    isValid: false,
    invalidReason: "signature_verification_error",
    payer: PAYER,
  });
  expect(JSON.stringify(result)).not.toContain("alchemy");
  expect(JSON.stringify(result)).not.toContain("ALCHEMYKEY123");
  expect(readContract).not.toHaveBeenCalled();
});

test("verify collapses a Solana scheme throw to a constant reason", async () => {
  primeSolanaFacilitator({
    verify: mock(async () => {
      throw new Error(LEAKY_MESSAGE);
    }),
    settle: mock(),
  });

  const result = await x402FacilitatorService.verify(solanaPaymentPayload(), solanaRequirements);

  expect(result).toEqual({ isValid: false, invalidReason: "solana_verification_error" });
  expect(JSON.stringify(result)).not.toContain("ALCHEMYKEY123");
});

test("verify sanitizes the @x402/svm invalidReason passthrough and drops invalidMessage", async () => {
  const svmScheme = {
    verify: mock(async () => ({
      isValid: false,
      // The decode/simulate failure paths return the raw thrown message.
      invalidReason: LEAKY_MESSAGE,
      invalidMessage: LEAKY_MESSAGE,
      payer: "",
    })),
    settle: mock(),
  };
  primeSolanaFacilitator(svmScheme);

  const leaky = await x402FacilitatorService.verify(solanaPaymentPayload(), solanaRequirements);
  expect(leaky.isValid).toBe(false);
  expect(leaky.invalidReason).toBe("solana_verification_failed");
  expect(JSON.stringify(leaky)).not.toContain("ALCHEMYKEY123");
  expect("invalidMessage" in leaky).toBe(false);

  // Dynamic-suffix reasons (program address appended) are not constants either.
  svmScheme.verify.mockResolvedValue({
    isValid: false,
    invalidReason: "smart_wallet_program_not_allowed: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payer: "",
  });
  const suffixed = await x402FacilitatorService.verify(solanaPaymentPayload(), solanaRequirements);
  expect(suffixed.invalidReason).toBe("solana_verification_failed");

  // Constant codes pass through unchanged.
  svmScheme.verify.mockResolvedValue({
    isValid: false,
    invalidReason: "invalid_exact_svm_payload_amount_mismatch",
    payer: "solana-payer",
  });
  const constant = await x402FacilitatorService.verify(solanaPaymentPayload(), solanaRequirements);
  expect(constant).toEqual({
    isValid: false,
    payer: "solana-payer",
    invalidReason: "invalid_exact_svm_payload_amount_mismatch",
  });
});

test("settle collapses a Solana scheme throw to a constant reason", async () => {
  primeSolanaFacilitator({
    verify: mock(),
    settle: mock(async () => {
      throw new Error(LEAKY_MESSAGE);
    }),
  });

  const result = await x402FacilitatorService.settle(solanaPaymentPayload(), solanaRequirements);

  expect(result).toEqual({
    success: false,
    transaction: "",
    network: SOLANA_NETWORK,
    errorReason: "solana_settlement_error",
  });
  expect(JSON.stringify(result)).not.toContain("ALCHEMYKEY123");
});

test("settle sanitizes the @x402/svm errorReason passthrough", async () => {
  const svmScheme = {
    verify: mock(),
    settle: mock(async () => ({
      success: false,
      transaction: "",
      network: SOLANA_NETWORK,
      payer: "",
      errorReason: LEAKY_MESSAGE,
      errorMessage: LEAKY_MESSAGE,
    })),
  };
  primeSolanaFacilitator(svmScheme);

  const leaky = await x402FacilitatorService.settle(solanaPaymentPayload(), solanaRequirements);
  expect(leaky.success).toBe(false);
  expect(leaky.errorReason).toBe("solana_settlement_failed");
  expect(JSON.stringify(leaky)).not.toContain("ALCHEMYKEY123");

  // Constant codes pass through unchanged.
  svmScheme.settle.mockResolvedValue({
    success: false,
    transaction: "",
    network: SOLANA_NETWORK,
    payer: "",
    errorReason: "duplicate_settlement",
  });
  const constant = await x402FacilitatorService.settle(solanaPaymentPayload(), solanaRequirements);
  expect(constant.errorReason).toBe("duplicate_settlement");
});
