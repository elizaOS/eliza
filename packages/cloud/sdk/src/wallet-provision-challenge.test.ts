/** Golden-bytes test for `buildWalletProvisionChallenge`: pins the exact client↔server wire string so the signing/recovery contract cannot drift. */

import { describe, expect, test } from "bun:test";
import {
  buildWalletProvisionChallenge,
  WALLET_PROVISION_CHALLENGE_PREFIX,
} from "./wallet-provision-challenge.js";

/**
 * The challenge is the client↔server wire contract: the client signs exactly
 * this string and the server (`@elizaos/cloud-shared`) rebuilds it byte-for-byte
 * to recover the signer. A golden assertion pins the bytes so neither side can
 * drift silently and break every provision.
 */
describe("buildWalletProvisionChallenge", () => {
  test("produces the exact, stable wire format", () => {
    const message = buildWalletProvisionChallenge({
      clientAddress: "0xAbC0000000000000000000000000000000000001",
      chainType: "evm",
      timestamp: 1_700_000_000_000,
      nonce: "nonce-123",
    });

    expect(message).toBe(
      [
        "Eliza Cloud Wallet Provision",
        "clientAddress: 0xabc0000000000000000000000000000000000001",
        "chainType: evm",
        "timestamp: 1700000000000",
        "nonce: nonce-123",
      ].join("\n"),
    );
  });

  test("lower-cases the address so signer-recovery is case-insensitive", () => {
    const checksummed = buildWalletProvisionChallenge({
      clientAddress: "0xAbC0000000000000000000000000000000000001",
      chainType: "solana",
      timestamp: 42,
      nonce: "n",
    });
    const lowercased = buildWalletProvisionChallenge({
      clientAddress: "0xabc0000000000000000000000000000000000001",
      chainType: "solana",
      timestamp: 42,
      nonce: "n",
    });
    expect(checksummed).toBe(lowercased);
  });

  test("distinct nonce / timestamp / chainType / address each change the message", () => {
    const base = {
      clientAddress: "0xabc0000000000000000000000000000000000001",
      chainType: "evm" as const,
      timestamp: 1,
      nonce: "a",
    };
    const baseMsg = buildWalletProvisionChallenge(base);
    expect(buildWalletProvisionChallenge({ ...base, nonce: "b" })).not.toBe(
      baseMsg,
    );
    expect(buildWalletProvisionChallenge({ ...base, timestamp: 2 })).not.toBe(
      baseMsg,
    );
    expect(
      buildWalletProvisionChallenge({ ...base, chainType: "solana" }),
    ).not.toBe(baseMsg);
    expect(
      buildWalletProvisionChallenge({
        ...base,
        clientAddress: "0xabc0000000000000000000000000000000000002",
      }),
    ).not.toBe(baseMsg);
  });

  test("exposes the prefix constant used as the first line", () => {
    expect(WALLET_PROVISION_CHALLENGE_PREFIX).toBe(
      "Eliza Cloud Wallet Provision",
    );
  });
});
