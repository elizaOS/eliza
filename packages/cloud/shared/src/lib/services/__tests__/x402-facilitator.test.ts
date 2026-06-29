import { expect, mock, test } from "bun:test";

const NETWORK = "eip155:8453";
const ASSET = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";
const FACILITATOR = "0x4444444444444444444444444444444444444444";
const SIGNATURE = "0xdeadbeef";
const NONCE = "0x0000000000000000000000000000000000000000000000000000000000000001";

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
  http: mock(() => ({})),
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

function primeEvmFacilitator() {
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
    },
  };
  service.clients = new Map([[NETWORK, { verifyTypedData, readContract }]]);
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
