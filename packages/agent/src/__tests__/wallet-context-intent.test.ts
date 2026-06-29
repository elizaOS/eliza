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
      "show my token balance",
      "what funds are in my crypto wallet?",
    ]) {
      expect(isWalletContextAugmentationIntent(prompt), prompt).toBe(true);
    }
  });
});
