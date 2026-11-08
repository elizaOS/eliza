/**
 * x402 facilitator: a payment is bound to the quoted network, scheme and
 * asset, and a broadcast transfer with an unknown outcome is reported as
 * pending instead of as a failure the payer may retry.
 */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  parseAbiItem,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const FACILITATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAYER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const PAY_TO = "0x00000000000000000000000000000000000000aa";
const BASE = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

process.env.X402_NETWORKS = "base,base-sepolia";
process.env.X402_RECIPIENT_ADDRESS = PAY_TO;

const { x402FacilitatorService } = await import("./x402-facilitator");

type Facilitator = typeof x402FacilitatorService;
type Payload = Parameters<Facilitator["verify"]>[0];
type Requirements = Parameters<Facilitator["verify"]>[1];

const payer = privateKeyToAccount(PAYER_KEY);
const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const AUTHORIZATION_USED = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);
const NONCE = `0x${"11".repeat(32)}` as Hex;

let service: Facilitator;
let receipt: () => Promise<unknown>;
let writeContract: ReturnType<typeof spyOn>;

function fakeClient() {
  return {
    verifyTypedData: (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
    readContract: async () => 10n ** 12n,
    waitForTransactionReceipt: () => receipt(),
  };
}

beforeEach(async () => {
  const Service = x402FacilitatorService.constructor as new () => Facilitator;
  service = new Service();
  const internals = service as unknown as {
    loadFacilitatorKey: () => Promise<string | null>;
    loadSolanaFacilitatorKey: () => Promise<string | null>;
    clients: Map<string, unknown>;
    createSettlementWalletClient: () => Promise<unknown>;
  };
  spyOn(internals, "loadFacilitatorKey").mockResolvedValue(FACILITATOR_KEY);
  spyOn(internals, "loadSolanaFacilitatorKey").mockResolvedValue(null);
  await service.initialize();
  internals.clients.set(BASE, fakeClient());
  internals.clients.set(BASE_SEPOLIA, fakeClient());
  writeContract = spyOn({ writeContract: async () => TX_HASH }, "writeContract");
  spyOn(internals, "createSettlementWalletClient").mockResolvedValue({ writeContract });
  receipt = async () => paidReceipt();
});

function paidReceipt(logs = [transferLog(), authorizationUsedLog()]) {
  return { status: "success", logs };
}

function transferLog(value = 5_000_000n) {
  return {
    address: BASE_USDC,
    topics: encodeEventTopics({
      abi: [TRANSFER],
      eventName: "Transfer",
      args: { from: payer.address, to: PAY_TO },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function authorizationUsedLog(nonce: Hex = NONCE) {
  return {
    address: BASE_USDC,
    topics: encodeEventTopics({
      abi: [AUTHORIZATION_USED],
      eventName: "AuthorizationUsed",
      args: { authorizer: payer.address, nonce },
    }),
    data: "0x",
  };
}

function requirements(overrides: Partial<Requirements> = {}): Requirements {
  return {
    scheme: "exact",
    network: BASE,
    asset: BASE_USDC,
    amount: "5000000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    ...overrides,
  };
}

async function exactPayment(
  options: { network?: string; chainId?: number; usdc?: string; scheme?: string } = {},
): Promise<Payload> {
  const network = options.network ?? BASE;
  const usdc = options.usdc ?? BASE_USDC;
  const authorization = {
    from: payer.address,
    to: PAY_TO,
    value: "5000000",
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    nonce: NONCE,
  };
  const signature = await payer.signTypedData({
    domain: {
      name: network === BASE ? "USD Coin" : "USDC",
      version: "2",
      chainId: options.chainId ?? (network === BASE ? 8453 : 84532),
      verifyingContract: usdc as Hex,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to as Hex,
      value: BigInt(authorization.value),
      validAfter: 0n,
      validBefore: BigInt(authorization.validBefore),
      nonce: NONCE,
    },
  });
  return {
    x402Version: 2,
    accepted: {
      scheme: options.scheme ?? "exact",
      network,
      asset: usdc,
      amount: "5000000",
      payTo: PAY_TO,
    },
    payload: { signature, authorization },
  };
}

describe("verify binds the payment to the quote", () => {
  test("an honest Base payment verifies", async () => {
    expect(await service.verify(await exactPayment(), requirements())).toEqual({
      isValid: true,
      payer: payer.address,
    });
  });

  test("a Base Sepolia authorization against a Base quote is a network mismatch", async () => {
    const testnet = await exactPayment({ network: BASE_SEPOLIA, usdc: BASE_SEPOLIA_USDC });
    const quote = requirements({ asset: BASE_SEPOLIA_USDC });

    expect(await service.verify(testnet, quote)).toEqual({
      isValid: false,
      invalidReason: "network_mismatch",
    });
    expect(await service.settle(testnet, quote)).toMatchObject({
      success: false,
      errorReason: "network_mismatch",
    });
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("a scheme other than the quoted one is rejected", async () => {
    const payment = await exactPayment({ scheme: "exact_permit" });

    expect(await service.verify(payment, requirements())).toEqual({
      isValid: false,
      invalidReason: "scheme_mismatch",
    });
  });

  test("a quote whose asset is not the network's USDC is rejected", async () => {
    const otherToken = "0x00000000000000000000000000000000000000bb";
    const payment = await exactPayment({ usdc: otherToken });

    expect(await service.verify(payment, requirements({ asset: otherToken }))).toEqual({
      isValid: false,
      invalidReason: "asset_not_supported",
    });
  });

  test("the 'upto' scheme is not supported", async () => {
    const payment = await exactPayment({ scheme: "upto" });

    expect(await service.verify(payment, requirements({ scheme: "upto" }))).toEqual({
      isValid: false,
      invalidReason: "scheme_not_supported: upto",
    });
  });
});

describe("settle reports what happened after broadcast", () => {
  test("a confirmed transfer settles", async () => {
    const broadcasts: unknown[] = [];

    const result = await service.settle(await exactPayment(), requirements(), {
      onBroadcast: async (sent) => {
        broadcasts.push(sent);
      },
    });

    expect(result).toEqual({
      success: true,
      transaction: TX_HASH,
      network: BASE,
      payer: payer.address,
    });
    expect(broadcasts).toEqual([{ transaction: TX_HASH, network: BASE, payer: payer.address }]);
  });

  test("a receipt timeout after broadcast is pending with the hash", async () => {
    receipt = async () => {
      throw new Error("Timed out while waiting for transaction");
    };

    expect(await service.settle(await exactPayment(), requirements())).toEqual({
      success: false,
      pending: true,
      transaction: TX_HASH,
      network: BASE,
      payer: payer.address,
      errorReason: "settlement_unconfirmed",
    });
  });

  test("a reverted receipt is a plain failure that moved no funds", async () => {
    receipt = async () => ({ status: "reverted", logs: [] });

    expect(await service.settle(await exactPayment(), requirements())).toEqual({
      success: false,
      transaction: TX_HASH,
      network: BASE,
      payer: payer.address,
      errorReason: "settlement_reverted",
    });
  });

  test("a rejected broadcast is a plain failure with no hash", async () => {
    writeContract.mockRejectedValueOnce(new Error("nonce too low"));

    expect(await service.settle(await exactPayment(), requirements())).toEqual({
      success: false,
      transaction: "",
      network: BASE,
      payer: payer.address,
      errorReason: "nonce_already_used",
    });
  });
});

describe("confirmSettlement", () => {
  test("a paid receipt for the authorization confirms", async () => {
    expect(
      await service.confirmSettlement({
        transaction: TX_HASH,
        requirements: requirements(),
        payer: payer.address,
        authorizationNonce: NONCE,
      }),
    ).toEqual({ success: true, transaction: TX_HASH, network: BASE, payer: payer.address });
  });

  test("a receipt that consumed a different authorization is refused", async () => {
    receipt = async () =>
      paidReceipt([transferLog(), authorizationUsedLog(`0x${"22".repeat(32)}`)]);

    expect(
      await service.confirmSettlement({
        transaction: TX_HASH,
        requirements: requirements(),
        payer: payer.address,
        authorizationNonce: NONCE,
      }),
    ).toMatchObject({ success: false, errorReason: "settlement_authorization_not_used" });
  });
});
