import { describe, expect, it } from "vitest";
import { sanitizeWalletDisplayLabel } from "./wallet-context-safety";

const EVM = `0x${"a1".repeat(20)}`;
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("sanitizeWalletDisplayLabel word-character boundaries", () => {
  it("still redacts a plain address", () => {
    expect(sanitizeWalletDisplayLabel(`USDC ${EVM}`)).toBe("USDC [address]");
  });
  it.each(["_", "z", "g"])("redacts EVM address followed by %s", (s) => {
    expect(sanitizeWalletDisplayLabel(`USDC ${EVM}${s}`)).not.toContain(EVM);
  });
  it.each(["_", "0", "O", "I", "l"])("redacts Solana address followed by %s", (s) => {
    expect(sanitizeWalletDisplayLabel(`T ${SOL}${s}`)).not.toContain(SOL);
  });
  it.each(["_", "0"])("redacts Solana address preceded by %s", (s) => {
    expect(sanitizeWalletDisplayLabel(`T ${s}${SOL}`)).not.toContain(SOL);
  });
});
