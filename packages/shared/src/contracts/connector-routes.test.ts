import { describe, expect, it } from "vitest";
import {
  PostConnectorRequestSchema,
  PostProviderSwitchRequestSchema,
} from "./connector-routes.js";

describe("PostConnectorRequestSchema", () => {
  it("trims name and accepts arbitrary config record", () => {
    const parsed = PostConnectorRequestSchema.parse({
      name: "  telegram  ",
      config: { token: "x", enabled: true },
    });
    expect(parsed.name).toBe("telegram");
    expect(parsed.config).toEqual({ token: "x", enabled: true });
  });

  it("accepts an empty config object", () => {
    expect(PostConnectorRequestSchema.parse({ name: "x", config: {} })).toEqual(
      { name: "x", config: {} },
    );
  });

  it("rejects whitespace-only name", () => {
    expect(() =>
      PostConnectorRequestSchema.parse({ name: " ", config: {} }),
    ).toThrow(/Missing connector name/);
  });

  it("rejects reserved object keys as name", () => {
    expect(() =>
      PostConnectorRequestSchema.parse({ name: "__proto__", config: {} }),
    ).toThrow(/reserved/);
    expect(() =>
      PostConnectorRequestSchema.parse({ name: "constructor", config: {} }),
    ).toThrow(/reserved/);
    expect(() =>
      PostConnectorRequestSchema.parse({ name: "prototype", config: {} }),
    ).toThrow(/reserved/);
  });

  it("rejects missing config", () => {
    expect(() => PostConnectorRequestSchema.parse({ name: "x" })).toThrow();
  });

  it("rejects non-object config", () => {
    expect(() =>
      PostConnectorRequestSchema.parse({ name: "x", config: "not-object" }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostConnectorRequestSchema.parse({
        name: "x",
        config: {},
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("PostProviderSwitchRequestSchema", () => {
  it("trims provider only when alone", () => {
    expect(
      PostProviderSwitchRequestSchema.parse({ provider: "  openai  " }),
    ).toEqual({ provider: "openai" });
  });

  it("accepts a full body and trims apiKey + primaryModel", () => {
    const parsed = PostProviderSwitchRequestSchema.parse({
      provider: "openai",
      apiKey: "  sk-x  ",
      primaryModel: "  gpt-5  ",
      useLocalEmbeddings: false,
    });
    expect(parsed).toEqual({
      provider: "openai",
      apiKey: "sk-x",
      primaryModel: "gpt-5",
      useLocalEmbeddings: false,
    });
  });

  it("absorbs whitespace-only optional fields as absent", () => {
    expect(
      PostProviderSwitchRequestSchema.parse({
        provider: "openai",
        apiKey: "  ",
        primaryModel: " ",
      }),
    ).toEqual({ provider: "openai" });
  });

  it("rejects whitespace-only provider", () => {
    expect(() =>
      PostProviderSwitchRequestSchema.parse({ provider: "  " }),
    ).toThrow(/Missing provider/);
  });

  it("rejects oversized apiKey", () => {
    const long = "x".repeat(513);
    expect(() =>
      PostProviderSwitchRequestSchema.parse({
        provider: "openai",
        apiKey: long,
      }),
    ).toThrow(/too long/);
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostProviderSwitchRequestSchema.parse({
        provider: "openai",
        baseUrl: "https://x",
      }),
    ).toThrow();
  });
});
