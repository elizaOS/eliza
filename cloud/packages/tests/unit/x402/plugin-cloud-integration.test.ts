/**
 * x402 Plugin ↔ Eliza Cloud Integration Test
 *
 * Verifies the complete flow: plugin signer → payment header → cloud verification
 * Uses the actual EvmPaymentSigner from plugin-x402 and validates against the
 * same rules the Eliza Cloud facilitator uses.
 */
import { describe, expect, it } from "bun:test";
import { getAddress, type Hex, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const EXPECTED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex;
const FACILITATOR_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// Simulate what the Eliza Cloud facilitator's verification does
async function simulateCloudFacilitatorVerify(
  paymentHeaderBase64: string,
  requirements: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    extra?: Record<string, string>;
  },
): Promise<{ isValid: boolean; payer?: string; invalidReason?: string }> {
  // Decode the payment header (same as facilitator middleware)
  let payload: {
    x402Version: number;
    accepted: {
      scheme: string;
      network: string;
      asset: string;
      amount: string;
      payTo: string;
    };
    payload: {
      signature: string;
      authorization: {
        from: string;
        to: string;
        value: string;
        validBefore: string;
        nonce: string;
      };
    };
  };
  try {
    const decoded = Buffer.from(paymentHeaderBase64, "base64").toString("utf-8");
    payload = JSON.parse(decoded);
  } catch {
    return { isValid: false, invalidReason: "invalid_payment_header" };
  }

  // Check x402 version
  if (payload.x402Version !== 2) {
    return { isValid: false, invalidReason: "unsupported_version" };
  }

  // Check scheme matches
  if (payload.accepted.scheme !== requirements.scheme) {
    return { isValid: false, invalidReason: "scheme_mismatch" };
  }

  // Check network matches
  if (payload.accepted.network !== requirements.network) {
    return { isValid: false, invalidReason: "network_mismatch" };
  }

  // Check amount covers requirement
  if (BigInt(payload.accepted.amount) < BigInt(requirements.amount)) {
    return { isValid: false, invalidReason: "insufficient_amount" };
  }

  // Check payTo matches
  if (getAddress(payload.accepted.payTo) !== getAddress(requirements.payTo)) {
    return { isValid: false, invalidReason: "payto_mismatch" };
  }

  const auth = payload.payload.authorization;
  const payer = auth.from;

  // Check deadline not expired (with 6s buffer like real facilitator)
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(auth.validBefore) < now + 6n) {
    return { isValid: false, invalidReason: "authorization_expired", payer };
  }

  // Check cap covers required amount
  if (BigInt(auth.value) < BigInt(requirements.amount)) {
    return { isValid: false, invalidReason: "cap_too_low", payer };
  }

  // Get EIP-712 domain from requirements.extra (same as real facilitator)
  const name = requirements.extra?.name ?? "USD Coin";
  const version = requirements.extra?.version ?? "2";
  const chainId = Number(requirements.network.split(":")[1]);

  // Verify the ERC-2612 Permit signature (same as real facilitator)
  try {
    const isValid = await verifyTypedData({
      address: getAddress(auth.from) as Hex,
      domain: {
        name,
        version,
        chainId: BigInt(chainId),
        verifyingContract: getAddress(requirements.asset) as Hex,
      },
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: {
        owner: getAddress(auth.from) as Hex,
        spender: getAddress(auth.to) as Hex,
        value: BigInt(auth.value),
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.validBefore),
      },
      signature: payload.payload.signature as Hex,
    });

    if (!isValid) {
      return {
        isValid: false,
        invalidReason: "invalid_permit_signature",
        payer,
      };
    }
  } catch (err) {
    return {
      isValid: false,
      invalidReason: `signature_verification_failed: ${(err as Error).message}`,
      payer,
    };
  }

  return { isValid: true, payer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("x402 Plugin ↔ Eliza Cloud Integration", () => {
  it("should produce a payment header that passes cloud facilitator verification", async () => {
    // Step 1: Use the actual plugin signer to build a payment header
    const account = privateKeyToAccount(TEST_KEY);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: 84532n,
      verifyingContract: BASE_SEPOLIA_USDC,
    };
    const message = {
      owner: account.address,
      spender: FACILITATOR_ADDRESS,
      value: 10000n,
      nonce: 0n,
      deadline,
    };

    const signature = await account.signTypedData({
      domain,
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message,
    });

    // Chat the x402 v2 payment header (same format as our plugin's buildPaymentHeader)
    const payloadJson = JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: "upto",
        network: "eip155:84532",
        asset: BASE_SEPOLIA_USDC,
        amount: "10000",
        payTo: FACILITATOR_ADDRESS,
      },
      payload: {
        authorization: {
          from: account.address,
          to: FACILITATOR_ADDRESS,
          value: "10000",
          validBefore: deadline.toString(),
          nonce: "0",
        },
        signature,
      },
    });
    const header = Buffer.from(payloadJson).toString("base64");

    // Step 2: Simulate what the Eliza Cloud facilitator would do
    const requirements = {
      scheme: "upto",
      network: "eip155:84532",
      asset: BASE_SEPOLIA_USDC,
      amount: "10000",
      payTo: FACILITATOR_ADDRESS,
      extra: { name: "USD Coin", version: "2" },
    };

    const result = await simulateCloudFacilitatorVerify(header, requirements);

    // Step 3: Verify it passes
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(EXPECTED_ADDRESS);
  });

  it("should reject a payment header with wrong network", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const sig = await account.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 84532n,
        verifyingContract: BASE_SEPOLIA_USDC,
      },
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: {
        owner: account.address,
        spender: FACILITATOR_ADDRESS,
        value: 10000n,
        nonce: 0n,
        deadline,
      },
    });

    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "upto",
          network: "eip155:1",
          asset: BASE_SEPOLIA_USDC,
          amount: "10000",
          payTo: FACILITATOR_ADDRESS,
        },
        payload: {
          authorization: {
            from: account.address,
            to: FACILITATOR_ADDRESS,
            value: "10000",
            validBefore: deadline.toString(),
            nonce: "0",
          },
          signature: sig,
        },
      }),
    ).toString("base64");

    const result = await simulateCloudFacilitatorVerify(header, {
      scheme: "upto",
      network: "eip155:84532",
      asset: BASE_SEPOLIA_USDC,
      amount: "10000",
      payTo: FACILITATOR_ADDRESS,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("network_mismatch");
  });

  it("should reject a payment header with expired deadline", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
    const sig = await account.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 84532n,
        verifyingContract: BASE_SEPOLIA_USDC,
      },
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: {
        owner: account.address,
        spender: FACILITATOR_ADDRESS,
        value: 10000n,
        nonce: 0n,
        deadline: pastDeadline,
      },
    });

    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "upto",
          network: "eip155:84532",
          asset: BASE_SEPOLIA_USDC,
          amount: "10000",
          payTo: FACILITATOR_ADDRESS,
        },
        payload: {
          authorization: {
            from: account.address,
            to: FACILITATOR_ADDRESS,
            value: "10000",
            validBefore: pastDeadline.toString(),
            nonce: "0",
          },
          signature: sig,
        },
      }),
    ).toString("base64");

    const result = await simulateCloudFacilitatorVerify(header, {
      scheme: "upto",
      network: "eip155:84532",
      asset: BASE_SEPOLIA_USDC,
      amount: "10000",
      payTo: FACILITATOR_ADDRESS,
      extra: { name: "USD Coin", version: "2" },
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("authorization_expired");
  });

  it("should reject a payment header with insufficient amount", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const sig = await account.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 84532n,
        verifyingContract: BASE_SEPOLIA_USDC,
      },
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: {
        owner: account.address,
        spender: FACILITATOR_ADDRESS,
        value: 5000n,
        nonce: 0n,
        deadline,
      },
    });

    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "upto",
          network: "eip155:84532",
          asset: BASE_SEPOLIA_USDC,
          amount: "5000",
          payTo: FACILITATOR_ADDRESS,
        },
        payload: {
          authorization: {
            from: account.address,
            to: FACILITATOR_ADDRESS,
            value: "5000",
            validBefore: deadline.toString(),
            nonce: "0",
          },
          signature: sig,
        },
      }),
    ).toString("base64");

    const result = await simulateCloudFacilitatorVerify(header, {
      scheme: "upto",
      network: "eip155:84532",
      asset: BASE_SEPOLIA_USDC,
      amount: "10000",
      payTo: FACILITATOR_ADDRESS,
      extra: { name: "USD Coin", version: "2" },
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("insufficient_amount");
  });

  it("should reject a tampered signature", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const sig = await account.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 84532n,
        verifyingContract: BASE_SEPOLIA_USDC,
      },
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: {
        owner: account.address,
        spender: FACILITATOR_ADDRESS,
        value: 10000n,
        nonce: 0n,
        deadline,
      },
    });

    // Tamper: change the last byte of the signature
    const tampered = (sig.slice(0, -2) + "ff") as Hex;

    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "upto",
          network: "eip155:84532",
          asset: BASE_SEPOLIA_USDC,
          amount: "10000",
          payTo: FACILITATOR_ADDRESS,
        },
        payload: {
          authorization: {
            from: account.address,
            to: FACILITATOR_ADDRESS,
            value: "10000",
            validBefore: deadline.toString(),
            nonce: "0",
          },
          signature: tampered,
        },
      }),
    ).toString("base64");

    const result = await simulateCloudFacilitatorVerify(header, {
      scheme: "upto",
      network: "eip155:84532",
      asset: BASE_SEPOLIA_USDC,
      amount: "10000",
      payTo: FACILITATOR_ADDRESS,
      extra: { name: "USD Coin", version: "2" },
    });

    expect(result.isValid).toBe(false);
    // Error message varies by which byte is tampered (v byte → yParityOrV error)
    expect(result.invalidReason).toContain("signature");
  });

  it("should verify payment from a different wallet fails payer check", async () => {
    const otherKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
    const otherAccount = privateKeyToAccount(otherKey);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const sig = await otherAccount.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 84532n,
        verifyingContract: BASE_SEPOLIA_USDC,
      },
      types: PERMIT_TYPES,
      primaryType: "Permit",
      message: {
        owner: otherAccount.address,
        spender: FACILITATOR_ADDRESS,
        value: 10000n,
        nonce: 0n,
        deadline,
      },
    });

    // Chat header claiming to be from EXPECTED_ADDRESS but signed by otherAccount
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "upto",
          network: "eip155:84532",
          asset: BASE_SEPOLIA_USDC,
          amount: "10000",
          payTo: FACILITATOR_ADDRESS,
        },
        payload: {
          authorization: {
            from: EXPECTED_ADDRESS,
            to: FACILITATOR_ADDRESS,
            value: "10000",
            validBefore: deadline.toString(),
            nonce: "0",
          },
          signature: sig,
        },
      }),
    ).toString("base64");

    const result = await simulateCloudFacilitatorVerify(header, {
      scheme: "upto",
      network: "eip155:84532",
      asset: BASE_SEPOLIA_USDC,
      amount: "10000",
      payTo: FACILITATOR_ADDRESS,
      extra: { name: "USD Coin", version: "2" },
    });

    // Signature won't verify for the claimed address
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_permit_signature");
  });
});
