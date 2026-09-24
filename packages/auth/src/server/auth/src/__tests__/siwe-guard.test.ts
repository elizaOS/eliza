import { describe, expect, test } from "bun:test";

import { evaluateSiwePolicy, type SiweMessageLike } from "../siwe-guard";

const NOW = new Date("2026-05-21T12:00:00Z");
const base: SiweMessageLike = {
  domain: "app.steward.fi",
  address: "0x1111111111111111111111111111111111111111",
  statement: "Sign in to elizaOS",
  uri: "https://app.steward.fi/login",
  version: "1",
  chainId: 8453,
  nonce: "abcdef1234567890",
  issuedAt: "2026-05-21T11:59:30Z",
  expirationTime: "2026-05-21T12:09:30Z",
};

const policy = {
  allowedDomains: ["app.steward.fi", "steward.fi"],
  allowedChainIds: [1, 8453],
  requiredStatement: "Sign in to elizaOS",
  maxLifetimeMs: 10 * 60_000,
  now: () => NOW,
};

describe("evaluateSiwePolicy", () => {
  test("returns null for a well-formed in-policy message", () => {
    expect(evaluateSiwePolicy(base, policy)).toBeNull();
  });

  test("rejects an unknown domain", () => {
    expect(evaluateSiwePolicy({ ...base, domain: "evil.com" }, policy)).toBe(
      "domain-not-allowed",
    );
  });

  test("rejects mismatched chainId", () => {
    expect(evaluateSiwePolicy({ ...base, chainId: 137 }, policy)).toBe(
      "chain-not-allowed",
    );
  });

  test("rejects mismatched statement (phishing defense)", () => {
    expect(
      evaluateSiwePolicy({ ...base, statement: "Approve all funds" }, policy),
    ).toBe("statement-mismatch");
  });

  test("rejects uri on a different host than `domain`", () => {
    expect(
      evaluateSiwePolicy(
        { ...base, uri: "https://attacker.example/login" },
        policy,
      ),
    ).toBe("uri-domain-mismatch");
  });

  test("rejects unparseable uri", () => {
    expect(evaluateSiwePolicy({ ...base, uri: "not-a-url" }, policy)).toBe(
      "uri-domain-mismatch",
    );
  });

  test("rejects SIWE version != '1'", () => {
    expect(evaluateSiwePolicy({ ...base, version: "2" }, policy)).toBe(
      "version-unsupported",
    );
  });

  test("rejects short or missing nonce", () => {
    expect(evaluateSiwePolicy({ ...base, nonce: "" }, policy)).toBe(
      "missing-nonce",
    );
    expect(evaluateSiwePolicy({ ...base, nonce: "short" }, policy)).toBe(
      "missing-nonce",
    );
  });

  test("rejects expired signature", () => {
    expect(
      evaluateSiwePolicy(
        { ...base, expirationTime: "2026-05-21T11:00:00Z" },
        policy,
      ),
    ).toBe("expired");
  });

  test("rejects message not yet valid (notBefore in the future)", () => {
    expect(
      evaluateSiwePolicy(
        { ...base, notBefore: "2026-05-21T13:00:00Z" },
        policy,
      ),
    ).toBe("not-yet-valid");
  });

  test("rejects pathologically long lifetimes even when not yet expired", () => {
    expect(
      evaluateSiwePolicy(
        {
          ...base,
          issuedAt: "2026-05-21T11:59:30Z",
          expirationTime: "2026-08-21T11:59:30Z",
        },
        policy,
      ),
    ).toBe("lifetime-too-long");
  });

  test("clockSkewMs tolerates small drift", () => {
    // expirationTime is 30s in the past — within default 30s skew.
    expect(
      evaluateSiwePolicy(
        { ...base, expirationTime: "2026-05-21T11:59:45Z" },
        { ...policy, clockSkewMs: 30_000 },
      ),
    ).toBeNull();
  });

  test("allowedChainIds undefined means any chain accepted", () => {
    const { allowedChainIds, ...rest } = policy;
    void allowedChainIds;
    expect(evaluateSiwePolicy({ ...base, chainId: 999_999 }, rest)).toBeNull();
  });

  test("rejects a message with no expirationTime once its issuedAt age exceeds maxLifetimeMs (SEC-065)", () => {
    const { expirationTime, ...noExpiry } = base;
    void expirationTime;
    // issuedAt is 30s ago — within the 10-minute bound, still accepted.
    expect(evaluateSiwePolicy(noExpiry, policy)).toBeNull();
    // issuedAt is 20 minutes ago — rejected even though nothing "expired".
    expect(
      evaluateSiwePolicy(
        { ...noExpiry, issuedAt: "2026-05-21T11:39:59Z" },
        policy,
      ),
    ).toBe("lifetime-too-long");
  });

  test("rejects a future-dated issuedAt beyond clock skew (SEC-065)", () => {
    expect(
      evaluateSiwePolicy({ ...base, issuedAt: "2026-05-21T12:05:00Z" }, policy),
    ).toBe("not-yet-valid");
    // Within skew — tolerated.
    expect(
      evaluateSiwePolicy({ ...base, issuedAt: "2026-05-21T12:00:15Z" }, policy),
    ).toBeNull();
  });
});
