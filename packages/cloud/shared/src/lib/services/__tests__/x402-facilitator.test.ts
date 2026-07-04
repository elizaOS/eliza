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
