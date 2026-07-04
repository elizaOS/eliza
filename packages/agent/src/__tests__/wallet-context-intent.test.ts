/**
 * Unit-tests `isWalletContextAugmentationIntent`, the heuristic gate deciding
 * whether an incoming prompt warrants injecting wallet / on-chain context. Pins
 * that it fires on explicit wallet or on-chain phrasing and stays quiet on
 * lookalike developer vocabulary (token/address/send/approve/transfer used
 * non-financially). Pure function; deterministic, no runtime.
 */
import { describe, expect, it } from "vitest";

import { isWalletContextAugmentationIntent } from "../api/server-helpers.ts";

describe("isWalletContextAugmentationIntent", () => {
  it("does not trigger wallet context on common developer words", () => {
    for (const prompt of [
      "paste the API_TOKEN into the env file",
      "send a request to the local server",
      "Sol shipped the connector fix",
      "what is the address of this HTTP endpoint?",
      "tokenize this TypeScript string",
      "buy groceries after the meeting",
      "approve the PR once CI is green",
      "transfer the files into the new folder",
      "send a request to the local server address",
    ]) {
      expect(isWalletContextAugmentationIntent(prompt), prompt).toBe(false);
    }
  });

  it("triggers wallet context for explicit wallet or on-chain requests", () => {
    for (const prompt of [
      "what is my wallet address?",
      "check my onchain balance",
      "send 1 bnb to this wallet",
      "swap eth for sol",
      "approve the token spend",
      "buy bnb onchain",
      "send 5 USDC to 0x1234567890123456789012345678901234567890",
      "transfer 1 USDT to 0x1234567890123456789012345678901234567890",
      "what is my USDC balance",
      "approve USDC spend",
      "bridge USDC to Solana",
      "show my token balance",
      "what funds are in my crypto wallet?",
    ]) {
      expect(isWalletContextAugmentationIntent(prompt), prompt).toBe(true);
    }
  });
});
