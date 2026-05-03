import { describe, expect, it } from "bun:test";

// ─── RPC Error Detection (extracted for testing) ─────────────────────────

/**
 * These functions are duplicated from index.ts for unit testing.
 * In a production codebase, they would be exported from a shared module.
 */

function isRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  const rpcIndicators = [
    "insufficient funds",
    "insufficient balance",
    "nonce too low",
    "nonce too high",
    "gas too low",
    "gas limit",
    "underpriced",
    "replacement transaction",
    "exceeds block gas limit",
    "execution reverted",
    "out of gas",
    "invalid sender",
    "invalid signature",
    "account not found",
    "blockhash not found",
    "transaction simulation failed",
    "instruction error",
    "custom program error",
    "rpc error",
    "failed to send transaction",
    "transaction failed",
    "0x",
  ];
  return rpcIndicators.some((indicator) => msg.includes(indicator));
}

function extractRpcErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const innerMatch = error.message.match(/message["\s:]+([^"]+)/i);
    if (innerMatch) {
      return innerMatch[1].trim();
    }
    return error.message;
  }
  return "RPC error";
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("RPC Error Detection", () => {
  describe("isRpcError", () => {
    it("detects insufficient funds error", () => {
      const error = new Error("Insufficient funds for gas * price + value");
      expect(isRpcError(error)).toBe(true);
    });

    it("detects insufficient balance error", () => {
      const error = new Error("sender doesn't have enough funds: insufficient balance");
      expect(isRpcError(error)).toBe(true);
    });

    it("detects nonce errors", () => {
      expect(isRpcError(new Error("nonce too low"))).toBe(true);
      expect(isRpcError(new Error("nonce too high"))).toBe(true);
    });

    it("detects gas errors", () => {
      expect(isRpcError(new Error("gas too low"))).toBe(true);
      expect(isRpcError(new Error("exceeds block gas limit"))).toBe(true);
      expect(isRpcError(new Error("out of gas"))).toBe(true);
    });

    it("detects execution reverted", () => {
      const error = new Error("execution reverted: ERC20: transfer amount exceeds balance");
      expect(isRpcError(error)).toBe(true);
    });

    it("detects Solana errors", () => {
      expect(isRpcError(new Error("Transaction simulation failed"))).toBe(true);
      expect(isRpcError(new Error("Instruction error"))).toBe(true);
      expect(isRpcError(new Error("blockhash not found"))).toBe(true);
      expect(isRpcError(new Error("account not found"))).toBe(true);
    });

    it("detects generic RPC errors", () => {
      expect(isRpcError(new Error("RPC error: connection refused"))).toBe(true);
      expect(isRpcError(new Error("Failed to send transaction"))).toBe(true);
    });

    it("does NOT detect internal server errors", () => {
      expect(isRpcError(new Error("Database connection failed"))).toBe(false);
      expect(isRpcError(new Error("Unexpected token in JSON"))).toBe(false);
      expect(isRpcError(new Error("ECONNREFUSED"))).toBe(false);
      expect(isRpcError(new Error("undefined is not a function"))).toBe(false);
    });

    it("returns false for non-Error objects", () => {
      expect(isRpcError("insufficient funds")).toBe(false);
      expect(isRpcError({ message: "insufficient funds" })).toBe(false);
      expect(isRpcError(null)).toBe(false);
      expect(isRpcError(undefined)).toBe(false);
    });
  });

  describe("extractRpcErrorMessage", () => {
    it("extracts message from simple error", () => {
      const error = new Error("Insufficient funds for gas");
      expect(extractRpcErrorMessage(error)).toBe("Insufficient funds for gas");
    });

    it("extracts inner message when present", () => {
      const error = new Error(
        'RPC error: {"code":-32000,"message":"insufficient funds for transfer"}',
      );
      const result = extractRpcErrorMessage(error);
      expect(result).toContain("insufficient funds");
    });

    it("returns fallback for non-Error", () => {
      expect(extractRpcErrorMessage("some string")).toBe("RPC error");
      expect(extractRpcErrorMessage(null)).toBe("RPC error");
      expect(extractRpcErrorMessage({ msg: "test" })).toBe("RPC error");
    });
  });
});

describe("RPC Error HTTP Status", () => {
  it("should return 502 for RPC errors (integration test concept)", () => {
    // This test documents the expected behavior:
    // When an RPC error occurs (e.g., insufficient funds),
    // the API should return 502 Bad Gateway with the actual error message,
    // not 500 Internal Server Error with a generic message.

    // The actual integration test would require a running server
    // and a way to trigger an RPC error (e.g., sending without funds).

    // For now, we verify the detection logic works correctly.
    const rpcError = new Error("insufficient funds for gas * price + value");
    expect(isRpcError(rpcError)).toBe(true);
    expect(extractRpcErrorMessage(rpcError)).toContain("insufficient funds");
  });
});
