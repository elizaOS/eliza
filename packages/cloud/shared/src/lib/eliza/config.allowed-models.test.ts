// Exercises config.allowed models behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "vitest";
import { expandBitRouterModelIdCandidates } from "../providers/model-id-translation";
import { ALLOWED_CHAT_MODELS, isAllowedChatModel } from "./config";

/**
 * `isAllowedChatModel` is the server-side allowlist that decides which chat
 * models a request may route to (#8801 — billing/abuse guard, shipped untested).
 * A regression that accepts an unlisted model bills the operator for a model
 * they never approved; one that rejects a legitimately-allowed model under its
 * alternate provider spelling breaks saved characters. Both are pinned here.
 */
describe("isAllowedChatModel", () => {
  it("accepts every id on the explicit allowlist", () => {
    for (const id of ["anthropic/claude-sonnet-4.6", "deepseek/deepseek-r1"]) {
      expect(ALLOWED_CHAT_MODELS).toContain(id);
      expect(isAllowedChatModel(id)).toBe(true);
    }
  });

  it("rejects an unlisted model", () => {
    expect(isAllowedChatModel("openai/gpt-4o-not-approved")).toBe(false);
    expect(isAllowedChatModel("evil/backdoor-model")).toBe(false);
  });

  it("rejects empty / whitespace ids", () => {
    expect(isAllowedChatModel("")).toBe(false);
    expect(isAllowedChatModel("   ")).toBe(false);
  });
});

describe("expandBitRouterModelIdCandidates (cross-spelling)", () => {
  it("offers both the legacy and BitRouter spelling for xAI / Mistral", () => {
    expect(expandBitRouterModelIdCandidates("xai/grok-4")).toContain("x-ai/grok-4");
    expect(expandBitRouterModelIdCandidates("x-ai/grok-4")).toContain("xai/grok-4");
    expect(expandBitRouterModelIdCandidates("mistral/codestral")).toContain("mistralai/codestral");
  });

  it("returns the id itself for providers with one spelling", () => {
    expect(expandBitRouterModelIdCandidates("anthropic/claude-sonnet-4.6")).toContain(
      "anthropic/claude-sonnet-4.6",
    );
  });

  it("returns nothing for an empty id (no false candidate)", () => {
    expect(expandBitRouterModelIdCandidates("")).toEqual([]);
    expect(expandBitRouterModelIdCandidates("   ")).toEqual([]);
  });
});
