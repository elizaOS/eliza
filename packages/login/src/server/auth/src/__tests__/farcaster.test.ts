import { describe, expect, it } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSiwfMessage, verifyFarcasterLogin } from "../farcaster";

const NOW = Date.parse("2026-05-25T12:00:00Z");

function buildSiwfMessage(
  address: string,
  overrides: {
    domain?: string;
    uri?: string;
    nonce?: string;
    issuedAt?: string;
    expirationTime?: string;
    notBefore?: string;
    fid?: string;
    includeFidResource?: boolean;
  } = {},
) {
  const domain = overrides.domain ?? "app.steward.fi";
  const uri = overrides.uri ?? "https://app.steward.fi/login/farcaster";
  const nonce = overrides.nonce ?? "abcdef123456";
  const issuedAt = overrides.issuedAt ?? "2026-05-25T11:59:00.000Z";
  const expirationTime = overrides.expirationTime ?? "2026-05-25T12:05:00.000Z";
  const fid = overrides.fid ?? "4242";
  const lines = [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in with Farcaster.",
    "",
    `URI: ${uri}`,
    "Version: 1",
    "Chain ID: 10",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ];
  if (overrides.notBefore) lines.push(`Not Before: ${overrides.notBefore}`);
  if (overrides.includeFidResource !== false) {
    lines.push("Resources:", `- farcaster://fid/${fid}`);
  }
  return lines.join("\n");
}

async function signedPayload(
  overrides: Parameters<typeof buildSiwfMessage>[1] = {},
) {
  const account = privateKeyToAccount(generatePrivateKey());
  const message = buildSiwfMessage(account.address, overrides);
  return {
    account,
    payload: {
      message,
      signature: await account.signMessage({ message }),
      custodyAddress: account.address,
      fid: overrides.fid ?? "4242",
      username: "alice",
      displayName: "Alice",
      pfpUrl: "https://example.com/alice.png",
    },
  };
}

describe("Farcaster SIWF verifier", () => {
  it("parses SIWF fields and resources", async () => {
    const { payload, account } = await signedPayload();
    const parsed = parseSiwfMessage(payload.message);

    expect(parsed).toMatchObject({
      domain: "app.steward.fi",
      address: account.address,
      uri: "https://app.steward.fi/login/farcaster",
      version: "1",
      chainId: 10,
      nonce: "abcdef123456",
      fid: "4242",
    });
    expect(parsed.resources).toEqual(["farcaster://fid/4242"]);
  });

  it("verifies a valid EIP-191 signature and returns normalized identity fields", async () => {
    const { payload, account } = await signedPayload();

    const verified = await verifyFarcasterLogin(payload, {
      expectedDomain: "app.steward.fi",
      expectedNonce: "abcdef123456",
      expectedUri: "https://app.steward.fi/login/farcaster",
      nowMs: NOW,
    });

    expect(verified).toMatchObject({
      claimedFid: "4242",
      custodyAddress: account.address,
      username: "alice",
      displayName: "Alice",
      pfpUrl: "https://example.com/alice.png",
    });
  });

  it("rejects wrong domain and nonce", async () => {
    const { payload } = await signedPayload();

    await expect(
      verifyFarcasterLogin(payload, {
        expectedDomain: "admin.steward.fi",
        expectedNonce: "abcdef123456",
        nowMs: NOW,
      }),
    ).rejects.toThrow("domain mismatch");

    await expect(
      verifyFarcasterLogin(payload, {
        expectedDomain: "app.steward.fi",
        expectedNonce: "wrongnonce",
        nowMs: NOW,
      }),
    ).rejects.toThrow("nonce mismatch");
  });

  it("rejects expired and not-yet-valid payloads", async () => {
    const expired = await signedPayload({
      expirationTime: "2026-05-25T11:00:00.000Z",
    });
    await expect(
      verifyFarcasterLogin(expired.payload, {
        expectedDomain: "app.steward.fi",
        expectedNonce: "abcdef123456",
        nowMs: NOW,
      }),
    ).rejects.toThrow("expired");

    const future = await signedPayload({
      notBefore: "2026-05-25T12:10:00.000Z",
    });
    await expect(
      verifyFarcasterLogin(future.payload, {
        expectedDomain: "app.steward.fi",
        expectedNonce: "abcdef123456",
        nowMs: NOW,
      }),
    ).rejects.toThrow("not yet valid");
  });

  it("rejects malformed signatures and addresses", async () => {
    const { payload } = await signedPayload();

    await expect(
      verifyFarcasterLogin({ ...payload, signature: "0x1234" }, { nowMs: NOW }),
    ).rejects.toThrow("signature is invalid");

    await expect(
      verifyFarcasterLogin(
        { ...payload, custodyAddress: "not-an-address" },
        { nowMs: NOW },
      ),
    ).rejects.toThrow("custodyAddress is invalid");
  });

  it("rejects message and identity tampering", async () => {
    const { payload } = await signedPayload();

    await expect(
      verifyFarcasterLogin(
        {
          ...payload,
          message: payload.message.replace(
            "farcaster://fid/4242",
            "farcaster://fid/7",
          ),
        },
        {
          expectedDomain: "app.steward.fi",
          expectedNonce: "abcdef123456",
          nowMs: NOW,
        },
      ),
    ).rejects.toThrow("signature mismatch");

    await expect(
      verifyFarcasterLogin(
        { ...payload, fid: "7" },
        {
          expectedDomain: "app.steward.fi",
          expectedNonce: "abcdef123456",
          nowMs: NOW,
        },
      ),
    ).rejects.toThrow("fid mismatch");
  });

  it("rejects unsigned top-level fid claims when the signed SIWF resources omit fid", async () => {
    const { payload } = await signedPayload({ includeFidResource: false });

    await expect(
      verifyFarcasterLogin(
        { ...payload, fid: "4242" },
        {
          expectedDomain: "app.steward.fi",
          expectedNonce: "abcdef123456",
          nowMs: NOW,
        },
      ),
    ).rejects.toThrow("fid mismatch");
  });
});
