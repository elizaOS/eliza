import { describe, expect, it } from "vitest";
import {
  PostWalletGenerateRequestSchema,
  PostWalletImportRequestSchema,
  PostWalletPrimaryRequestSchema,
} from "./wallet-routes.js";

describe("PostWalletImportRequestSchema", () => {
  it("trims privateKey and accepts evm chain", () => {
    expect(
      PostWalletImportRequestSchema.parse({
        chain: "evm",
        privateKey: "  0xdeadbeef  ",
      }),
    ).toEqual({ chain: "evm", privateKey: "0xdeadbeef" });
  });

  it("accepts solana chain", () => {
    expect(
      PostWalletImportRequestSchema.parse({
        chain: "solana",
        privateKey: "abc",
      }),
    ).toEqual({ chain: "solana", privateKey: "abc" });
  });

  it("works without chain (server auto-detects)", () => {
    expect(
      PostWalletImportRequestSchema.parse({ privateKey: "0xabc" }),
    ).toEqual({ privateKey: "0xabc" });
  });

  it("rejects bad chain", () => {
    expect(() =>
      PostWalletImportRequestSchema.parse({
        chain: "bitcoin",
        privateKey: "x",
      }),
    ).toThrow();
  });

  it("rejects whitespace privateKey", () => {
    expect(() =>
      PostWalletImportRequestSchema.parse({ privateKey: " " }),
    ).toThrow(/privateKey is required/);
  });

  it("rejects missing privateKey", () => {
    expect(() => PostWalletImportRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostWalletImportRequestSchema.parse({
        privateKey: "x",
        rotate: true,
      }),
    ).toThrow();
  });
});

describe("PostWalletGenerateRequestSchema", () => {
  it("accepts an empty body (defaults applied server-side)", () => {
    expect(PostWalletGenerateRequestSchema.parse({})).toEqual({});
  });

  it("accepts each chain + source combo", () => {
    expect(
      PostWalletGenerateRequestSchema.parse({ chain: "both", source: "local" }),
    ).toEqual({ chain: "both", source: "local" });
    expect(
      PostWalletGenerateRequestSchema.parse({
        chain: "evm",
        source: "steward",
      }),
    ).toEqual({ chain: "evm", source: "steward" });
  });

  it("rejects unknown chain", () => {
    expect(() =>
      PostWalletGenerateRequestSchema.parse({ chain: "btc" }),
    ).toThrow();
  });

  it("rejects unknown source", () => {
    expect(() =>
      PostWalletGenerateRequestSchema.parse({ source: "vault" }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostWalletGenerateRequestSchema.parse({
        chain: "evm",
        seed: "abc",
      }),
    ).toThrow();
  });
});

describe("PostWalletPrimaryRequestSchema", () => {
  it("accepts evm + cloud", () => {
    expect(
      PostWalletPrimaryRequestSchema.parse({ chain: "evm", source: "cloud" }),
    ).toEqual({ chain: "evm", source: "cloud" });
  });

  it("accepts solana + local", () => {
    expect(
      PostWalletPrimaryRequestSchema.parse({
        chain: "solana",
        source: "local",
      }),
    ).toEqual({ chain: "solana", source: "local" });
  });

  it("rejects bad chain", () => {
    expect(() =>
      PostWalletPrimaryRequestSchema.parse({
        chain: "bitcoin",
        source: "local",
      }),
    ).toThrow();
  });

  it("rejects bad source", () => {
    expect(() =>
      PostWalletPrimaryRequestSchema.parse({
        chain: "evm",
        source: "steward",
      }),
    ).toThrow();
  });

  it("rejects missing fields", () => {
    expect(() =>
      PostWalletPrimaryRequestSchema.parse({ chain: "evm" }),
    ).toThrow();
    expect(() =>
      PostWalletPrimaryRequestSchema.parse({ source: "cloud" }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostWalletPrimaryRequestSchema.parse({
        chain: "evm",
        source: "cloud",
        force: true,
      }),
    ).toThrow();
  });
});
