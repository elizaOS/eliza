import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasHuggingFaceToken,
  isHuggingFaceHost,
  resolveHubAuthHeaders,
  resolveHuggingFaceToken,
} from "./hub-auth.ts";

const KEYS = ["HF_TOKEN", "HUGGINGFACE_TOKEN", "HF_HUB_TOKEN"] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) ORIGINAL[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

describe("resolveHuggingFaceToken", () => {
  it("reads the first configured alias", () => {
    process.env.HF_TOKEN = " abc ";
    process.env.HUGGINGFACE_TOKEN = "def";
    expect(resolveHuggingFaceToken()).toBe("abc");
  });

  it("falls through aliases and returns empty", () => {
    process.env.HF_TOKEN = "";
    process.env.HF_HUB_TOKEN = "hub-token";
    expect(resolveHuggingFaceToken()).toBe("hub-token");
    delete process.env.HF_HUB_TOKEN;
    expect(resolveHuggingFaceToken()).toBe("");
  });
});

describe("hasHuggingFaceToken", () => {
  it("is true when a token is configured", () => {
    process.env.HF_TOKEN = "t";
    expect(hasHuggingFaceToken()).toBe(true);
  });

  it("is false when unset", () => {
    expect(hasHuggingFaceToken()).toBe(false);
  });
});

describe("isHuggingFaceHost", () => {
  it("matches huggingface.co and subdomains", () => {
    expect(isHuggingFaceHost("https://huggingface.co/x")).toBe(true);
    expect(isHuggingFaceHost("https://cdn-lfs.huggingface.co/x")).toBe(true);
  });

  it("rejects other hosts and junk", () => {
    expect(isHuggingFaceHost("https://modelscope.cn/x")).toBe(false);
    expect(isHuggingFaceHost("not a url")).toBe(false);
  });
});

describe("resolveHubAuthHeaders", () => {
  it("attaches the bearer header only to HF hosts", () => {
    process.env.HF_TOKEN = "secret";
    expect(resolveHubAuthHeaders("https://huggingface.co/x")).toEqual({
      authorization: "Bearer secret",
    });
    expect(resolveHubAuthHeaders("https://modelscope.cn/x")).toEqual({});
  });

  it("returns empty when no token", () => {
    expect(resolveHubAuthHeaders("https://huggingface.co/x")).toEqual({});
  });
});
