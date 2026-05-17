import { describe, expect, it } from "vitest";
import {
  PostSubscriptionAnthropicExchangeRequestSchema,
  PostSubscriptionAnthropicSetupTokenRequestSchema,
  PostSubscriptionOpenAIExchangeRequestSchema,
} from "./subscription-routes.js";

describe("PostSubscriptionAnthropicExchangeRequestSchema", () => {
  it("trims code", () => {
    expect(
      PostSubscriptionAnthropicExchangeRequestSchema.parse({
        code: "  abc123  ",
      }),
    ).toEqual({ code: "abc123" });
  });

  it("rejects whitespace-only code", () => {
    expect(() =>
      PostSubscriptionAnthropicExchangeRequestSchema.parse({ code: "  " }),
    ).toThrow(/Missing code/);
  });

  it("rejects missing code", () => {
    expect(() =>
      PostSubscriptionAnthropicExchangeRequestSchema.parse({}),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostSubscriptionAnthropicExchangeRequestSchema.parse({
        code: "x",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("PostSubscriptionAnthropicSetupTokenRequestSchema", () => {
  it("trims and accepts a valid sk-ant- token", () => {
    expect(
      PostSubscriptionAnthropicSetupTokenRequestSchema.parse({
        token: " sk-ant-oat01-abc ",
      }),
    ).toEqual({ token: "sk-ant-oat01-abc" });
  });

  it("rejects token without sk-ant- prefix", () => {
    expect(() =>
      PostSubscriptionAnthropicSetupTokenRequestSchema.parse({
        token: "sk-other-abc",
      }),
    ).toThrow(/sk-ant-oat01/);
  });

  it("rejects whitespace-only token", () => {
    expect(() =>
      PostSubscriptionAnthropicSetupTokenRequestSchema.parse({
        token: "   ",
      }),
    ).toThrow(/token is required/);
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostSubscriptionAnthropicSetupTokenRequestSchema.parse({
        token: "sk-ant-x",
        keep: true,
      }),
    ).toThrow();
  });
});

describe("PostSubscriptionOpenAIExchangeRequestSchema", () => {
  it("accepts code-only", () => {
    expect(
      PostSubscriptionOpenAIExchangeRequestSchema.parse({ code: "  abc  " }),
    ).toEqual({ code: "abc" });
  });

  it("accepts waitForCallback alone", () => {
    expect(
      PostSubscriptionOpenAIExchangeRequestSchema.parse({
        waitForCallback: true,
      }),
    ).toEqual({ waitForCallback: true });
  });

  it("accepts both", () => {
    expect(
      PostSubscriptionOpenAIExchangeRequestSchema.parse({
        code: "x",
        waitForCallback: false,
      }),
    ).toEqual({ code: "x", waitForCallback: false });
  });

  it("absorbs whitespace-only code", () => {
    expect(
      PostSubscriptionOpenAIExchangeRequestSchema.parse({ code: " " }),
    ).toEqual({});
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostSubscriptionOpenAIExchangeRequestSchema.parse({
        code: "x",
        nonce: "y",
      }),
    ).toThrow();
  });
});
