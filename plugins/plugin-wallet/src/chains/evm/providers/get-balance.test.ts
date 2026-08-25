import { __setParseJSONObjectFromTextResult } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIntentModel } from "../../../utils/intent-trajectory";
import { tokenBalanceProvider } from "./get-balance";
import { initWalletProvider } from "./wallet";

function message(text: string) {
  return { content: { text } } as never;
}

describe("token balance provider intent gate", () => {
  beforeEach(() => {
    runIntentModel.mockReset();
    runIntentModel.mockResolvedValue("{}");
    initWalletProvider.mockReset();
    __setParseJSONObjectFromTextResult(null);
  });

  it("returns an empty result without calling the model for unrelated text", async () => {
    const result = await tokenBalanceProvider.get({} as never, message("tell me a joke"));
    expect(result).toEqual({ text: "", data: {}, values: {} });
    expect(runIntentModel).not.toHaveBeenCalled();
  });

  it("passes the gate for the singular keyword forms", async () => {
    await tokenBalanceProvider.get({} as never, message("what is my wallet balance"));
    expect(runIntentModel).toHaveBeenCalledTimes(1);
    await tokenBalanceProvider.get({} as never, message("show token holdings"));
    expect(runIntentModel).toHaveBeenCalledTimes(2);
    await tokenBalanceProvider.get({} as never, message("erc20 positions"));
    expect(runIntentModel).toHaveBeenCalledTimes(3);
  });

  it("passes the gate for plural forms like wallets and tokens", async () => {
    await tokenBalanceProvider.get({} as never, message("check my wallets"));
    expect(runIntentModel).toHaveBeenCalledTimes(1);
    await tokenBalanceProvider.get({} as never, message("list my tokens"));
    expect(runIntentModel).toHaveBeenCalledTimes(2);
    await tokenBalanceProvider.get({} as never, message("what chains do I hold"));
    expect(runIntentModel).toHaveBeenCalledTimes(3);
  });

  it("returns an empty result when the model output carries no token/chain", async () => {
    __setParseJSONObjectFromTextResult(null);
    const result = await tokenBalanceProvider.get({} as never, message("wallet balance"));
    expect(result).toEqual({ text: "", data: {}, values: {} });
  });

  it("never throws and reports an error result for an unconfigured chain", async () => {
    __setParseJSONObjectFromTextResult({ token: "USDC", chain: "solana" });
    initWalletProvider.mockResolvedValue({ chains: {} } as never);
    const result = await tokenBalanceProvider.get({} as never, message("wallet balance"));
    expect(result.values.tokenBalanceAvailable).toBe(false);
    expect(String(result.text)).toContain("Token balance unavailable");
  });
});
