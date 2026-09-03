/**
 * Exercises the SIWS message parser and validator directly.
 *
 * `siws-helpers.security.test.ts` covers the uri/chainId binding through
 * `validateAndConsumeSIWS`; nothing referenced `parseSiwsMessage` or
 * `validateSIWSMessage`. Mutating each guard, the signature check itself
 * (`if (!ok)`) survived — so these pin the parse and the verify, not the
 * nonce store.
 *
 * Signatures here are REAL ed25519 signatures (tweetnacl) over the REAL
 * message bytes; nothing is stubbed.
 */

import { describe, expect, test } from "bun:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { buildSiwsMessage, parseSiwsMessage, validateSIWSMessage } from "./siws-helpers";

const HOST = "app.example.com";
const URI = "https://app.example.com";
const CHAIN = "solana:mainnet";
const NONCE = "0123456789abcdef0123456789abcdef";

function keypair() {
  const kp = nacl.sign.keyPair();
  return { kp, address: bs58.encode(kp.publicKey) };
}

function signed(
  over: Partial<Parameters<typeof buildSiwsMessage>[0]> = {},
  mutate: (message: string) => string = (m) => m,
) {
  const { kp, address } = keypair();
  const message = mutate(
    buildSiwsMessage({
      domain: HOST,
      address,
      statement: "Sign in",
      uri: URI,
      chainId: CHAIN,
      nonce: NONCE,
      issuedAt: new Date(),
      ...over,
    }),
  );
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey),
  );
  return { message, signature, address, kp };
}

describe("parseSiwsMessage", () => {
  test("round-trips what buildSiwsMessage produces", () => {
    const { kp, address } = keypair();
    const issuedAt = new Date("2026-01-02T03:04:05.000Z");
    const expirationTime = new Date("2026-01-02T04:04:05.000Z");
    const message = buildSiwsMessage({
      domain: HOST,
      address,
      statement: "Sign in",
      uri: URI,
      chainId: CHAIN,
      nonce: NONCE,
      issuedAt,
      expirationTime,
    });
    const parsed = parseSiwsMessage(message);
    expect(parsed).toMatchObject({
      domain: HOST,
      address,
      statement: "Sign in",
      uri: URI,
      version: "1",
      chainId: CHAIN,
      nonce: NONCE,
    });
    expect(parsed.issuedAt.toISOString()).toBe(issuedAt.toISOString());
    expect(parsed.expirationTime?.toISOString()).toBe(expirationTime.toISOString());
    expect(parsed.notBefore).toBeUndefined();
    expect(kp.publicKey.length).toBe(32);
  });

  test("parses a message with no statement", () => {
    const { address } = keypair();
    const message = buildSiwsMessage({
      domain: HOST,
      address,
      uri: URI,
      chainId: CHAIN,
      nonce: NONCE,
      issuedAt: new Date(),
    });
    const parsed = parseSiwsMessage(message);
    expect(parsed.statement).toBeUndefined();
    expect(parsed.uri).toBe(URI);
  });

  // A statement is detected by "the line after the blank has no colon". A
  // statement that legitimately contains one is therefore read as a field
  // line, not as the statement — pinned as the parser's actual behaviour so a
  // future change to the heuristic is a visible decision.
  test("does not treat a colon-bearing statement as a statement", () => {
    const { address } = keypair();
    const message = buildSiwsMessage({
      domain: HOST,
      address,
      statement: "Sign in: to Eliza",
      uri: URI,
      chainId: CHAIN,
      nonce: NONCE,
      issuedAt: new Date(),
    });
    const parsed = parseSiwsMessage(message);
    expect(parsed.statement).toBeUndefined();
    expect(parsed.uri).toBe(URI);
    expect(parsed.nonce).toBe(NONCE);
  });

  test("rejects a message shorter than the minimum line count", () => {
    expect(() => parseSiwsMessage("a\nb\nc")).toThrow(/too short/);
  });

  test.each([
    ["a missing header", "not a header at all"],
    ["a header with trailing text", `${HOST} wants you to sign in with your Solana account: now`],
  ])("rejects %s", (_label, header) => {
    const { address } = keypair();
    const body = [
      header,
      address,
      "",
      `URI: ${URI}`,
      "Version: 1",
      `Chain ID: ${CHAIN}`,
      `Nonce: ${NONCE}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    expect(() => parseSiwsMessage(body)).toThrow(/missing header/);
  });

  // The address pattern is anchored at both ends. Without the trailing `$`,
  // an address with appended bytes parses as valid and is then handed to
  // bs58.decode as the signer identity.
  test.each([
    ["trailing punctuation", "11111111111111111111111111111112!"],
    ["a leading zero (not base58)", "011111111111111111111111111111112"],
    ["too short", "1111111111111111111111111111111"],
    ["a non-base58 alphabet", "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO"],
    ["an empty line", ""],
  ])("rejects an address with %s", (_label, address) => {
    const body = [
      `${HOST} wants you to sign in with your Solana account:`,
      address,
      "",
      `URI: ${URI}`,
      "Version: 1",
      `Chain ID: ${CHAIN}`,
      `Nonce: ${NONCE}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    expect(() => parseSiwsMessage(body)).toThrow(/valid base58 Solana address|too short/);
  });

  test.each([
    ["URI", "URI"],
    ["Version", "Version"],
    ["Chain ID", "Chain ID"],
    ["Nonce", "Nonce"],
    ["Issued At", "Issued At"],
  ])("rejects a message missing %s", (_label, field) => {
    const { address } = keypair();
    const lines = [
      `${HOST} wants you to sign in with your Solana account:`,
      address,
      "",
      `URI: ${URI}`,
      "Version: 1",
      `Chain ID: ${CHAIN}`,
      `Nonce: ${NONCE}`,
      `Issued At: ${new Date().toISOString()}`,
      "Padding One: x",
      "Padding Two: x",
    ].filter((line) => !line.startsWith(`${field}:`));
    expect(() => parseSiwsMessage(lines.join("\n"))).toThrow(/missing required field/);
  });

  test("rejects an unparseable Issued At", () => {
    const { address } = keypair();
    const body = [
      `${HOST} wants you to sign in with your Solana account:`,
      address,
      "",
      `URI: ${URI}`,
      "Version: 1",
      `Chain ID: ${CHAIN}`,
      `Nonce: ${NONCE}`,
      "Issued At: yesterday-ish",
    ].join("\n");
    expect(() => parseSiwsMessage(body)).toThrow(/Issued At is not a valid date/);
  });
});

describe("validateSIWSMessage", () => {
  test("accepts a real signature over a well-formed message", () => {
    const { message, signature, address } = signed();
    const result = validateSIWSMessage(message, signature, HOST);
    expect(result.address).toBe(address);
    expect(result.parsed.nonce).toBe(NONCE);
  });

  // The one that mattered most: nothing in the suite failed when the
  // `nacl.sign.detached.verify` result was ignored.
  test("rejects a signature made by a different key", () => {
    const { message } = signed();
    const other = nacl.sign.keyPair();
    const foreign = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(message), other.secretKey),
    );
    expect(() => validateSIWSMessage(message, foreign, HOST)).toThrow(/signature invalid/);
  });

  test("rejects a valid signature over different bytes", () => {
    const { signature } = signed();
    const { message: otherMessage } = signed({ nonce: "f".repeat(32) });
    expect(() => validateSIWSMessage(otherMessage, signature, HOST)).toThrow(/signature invalid/);
  });

  // A single flipped byte anywhere in the signed text must invalidate it.
  test("rejects a message tampered with after signing", () => {
    const { message, signature } = signed();
    const tampered = message.replace(`URI: ${URI}`, `URI: ${URI}/evil`);
    expect(tampered).not.toBe(message);
    expect(() => validateSIWSMessage(tampered, signature, HOST)).toThrow();
  });

  test("rejects a domain that is not the app host", () => {
    const { message, signature } = signed({ domain: "evil.example.com" });
    expect(() => validateSIWSMessage(message, signature, HOST)).toThrow(
      /domain does not match app host/,
    );
  });

  test("rejects a signature that is not 64 bytes", () => {
    const { message } = signed();
    const short = bs58.encode(new Uint8Array(63));
    expect(() => validateSIWSMessage(message, short, HOST)).toThrow(/signature is not 64 bytes/);
  });

  // A 32-byte address is enforced separately from the base58 alphabet: a
  // base58 string can be the right shape and still decode to the wrong length.
  test("rejects an address that decodes to fewer than 32 bytes", () => {
    // 31 high bytes so the base58 form is long enough to satisfy the address
    // pattern — the point is that a well-formed address string can still
    // decode to the wrong key length.
    const shortKey = bs58.encode(new Uint8Array(31).fill(255));
    expect(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(shortKey)).toBe(true);
    const message = [
      `${HOST} wants you to sign in with your Solana account:`,
      shortKey,
      "",
      `URI: ${URI}`,
      "Version: 1",
      `Chain ID: ${CHAIN}`,
      `Nonce: ${NONCE}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    expect(() => validateSIWSMessage(message, bs58.encode(new Uint8Array(64)), HOST)).toThrow(
      /not a 32-byte ed25519 public key/,
    );
  });

  test("rejects an expired message even with a valid signature", () => {
    const { message, signature } = signed({
      expirationTime: new Date(Date.now() - 60_000),
    });
    expect(() => validateSIWSMessage(message, signature, HOST)).toThrow(/has expired/);
  });

  test("accepts a message whose expiration is still in the future", () => {
    const { message, signature } = signed({
      expirationTime: new Date(Date.now() + 600_000),
    });
    expect(() => validateSIWSMessage(message, signature, HOST)).not.toThrow();
  });

  test("rejects a message that is not yet valid", () => {
    const { message, signature } = signed(
      {},
      (m) => `${m}\nNot Before: ${new Date(Date.now() + 600_000).toISOString()}`,
    );
    expect(() => validateSIWSMessage(message, signature, HOST)).toThrow(/not yet valid/);
  });

  test("accepts a Not Before that has already passed", () => {
    const { message, signature } = signed(
      {},
      (m) => `${m}\nNot Before: ${new Date(Date.now() - 600_000).toISOString()}`,
    );
    expect(() => validateSIWSMessage(message, signature, HOST)).not.toThrow();
  });

  // Recorded rather than asserted-as-desirable: `Expiration Time` and
  // `Not Before` are parsed with `new Date(...)` and never checked for NaN,
  // and `NaN <= now` / `NaN > now` are both false — so an unparseable value
  // skips the window check instead of failing closed. `siwe-helpers.ts` has
  // the same shape at its own lines 159/162, so this is a shared design point
  // rather than a SIWS-only slip. Pinned here so a future NaN guard is a
  // deliberate change with a failing test to update, not a silent one.
  test.each([["Expiration Time"], ["Not Before"]])(
    "currently ignores an unparseable %s rather than failing closed",
    (field) => {
      const { message, signature } = signed({}, (m) => `${m}\n${field}: whenever`);
      const parsed = parseSiwsMessage(message);
      const value = field === "Expiration Time" ? parsed.expirationTime : parsed.notBefore;
      expect(value).toBeInstanceOf(Date);
      expect(Number.isNaN(value?.getTime())).toBe(true);
      expect(() => validateSIWSMessage(message, signature, HOST)).not.toThrow();
    },
  );

  test("enforces the uri and chainId binding when one is supplied", () => {
    const { message, signature } = signed();
    expect(() =>
      validateSIWSMessage(message, signature, HOST, { uri: URI, chainId: CHAIN }),
    ).not.toThrow();
    expect(() =>
      validateSIWSMessage(message, signature, HOST, {
        uri: "https://evil.example.com",
        chainId: CHAIN,
      }),
    ).toThrow(/uri does not match/);
    expect(() =>
      validateSIWSMessage(message, signature, HOST, {
        uri: URI,
        chainId: "solana:devnet",
      }),
    ).toThrow(/chainId does not match/);
  });
});

describe("buildSiwsMessage", () => {
  test("emits Version 1 and omits absent optional lines", () => {
    const { address } = keypair();
    const message = buildSiwsMessage({
      domain: HOST,
      address,
      uri: URI,
      chainId: CHAIN,
      nonce: NONCE,
      issuedAt: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(message.split("\n")).toEqual([
      `${HOST} wants you to sign in with your Solana account:`,
      address,
      "",
      `URI: ${URI}`,
      "Version: 1",
      `Chain ID: ${CHAIN}`,
      `Nonce: ${NONCE}`,
      "Issued At: 2026-01-02T03:04:05.000Z",
    ]);
    expect(parseSiwsMessage(message).version).toBe("1");
  });
});
