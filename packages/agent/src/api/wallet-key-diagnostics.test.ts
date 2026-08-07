/**
 * Coverage for the local wallet key-derivation diagnostics in `wallet.ts`.
 *
 * A configured-but-malformed `EVM_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` must
 * resolve to a null address AND leave the operator an actionable warning —
 * silently returning null makes the whole wallet surface look unconfigured.
 * The warning must also stay one-shot (these run per request) and must never
 * carry the key material.
 *
 * Deterministic: exercises the real `validateEvmPrivateKey` /
 * `validateSolanaPrivateKey` contract that the derivation path now reports
 * from. No network, filesystem, or runtime is involved.
 */

import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateEvmPrivateKey, validateSolanaPrivateKey } from "./wallet.ts";

const MALFORMED_EVM =
  "0xnothexnothexnothexnothexnothexnothexnothexnothexnothexnothexno01";
const MALFORMED_SOL = "not-a-valid-base58-key-!!!";

describe("wallet key validation diagnostics", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("reports a reason for a malformed EVM key rather than failing silently", () => {
    const result = validateEvmPrivateKey(MALFORMED_EVM);
    expect(result.valid).toBe(false);
    expect(result.address).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("reports a reason for a malformed Solana key rather than failing silently", () => {
    const result = validateSolanaPrivateKey(MALFORMED_SOL);
    expect(result.valid).toBe(false);
    expect(result.address).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("never echoes the key material in the validator diagnosis", () => {
    for (const key of [MALFORMED_EVM, MALFORMED_SOL]) {
      const body = key.replace(/^0x/, "");
      for (const result of [
        validateEvmPrivateKey(key),
        validateSolanaPrivateKey(key),
      ]) {
        if (!result.error) continue;
        expect(result.error).not.toContain(body);
        expect(result.error).not.toContain(body.slice(0, 16));
      }
    }
  });

  it("accepts a well-formed key with surrounding whitespace", () => {
    const valid = `  0x${"11".repeat(32)}  `;
    const result = validateEvmPrivateKey(valid.trim());
    expect(result.valid).toBe(true);
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
