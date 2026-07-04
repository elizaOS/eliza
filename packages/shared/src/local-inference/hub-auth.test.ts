/**
 * Covers the HuggingFace hub-auth helpers: token resolution across the
 * documented env aliases (in precedence order, trimmed, blank-as-unset), strict
 * huggingface.co host recognition, and bearer-header attachment that fires only
 * for HF hosts so a token is never leaked to mirrors. The harness saves/restores
 * the HF_* token env vars around each case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasHuggingFaceToken,
  isHuggingFaceHost,
  resolveHubAuthHeaders,
  resolveHuggingFaceToken,
} from "./hub-auth.js";

const TOKEN_ENV_KEYS = [
  "HF_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HF_HUB_TOKEN",
] as const;

describe("hub-auth", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TOKEN_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of TOKEN_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("reads the token from each documented env alias, in precedence order", () => {
    expect(resolveHuggingFaceToken()).toBe("");
    expect(hasHuggingFaceToken()).toBe(false);

    process.env.HF_HUB_TOKEN = "hub";
    expect(resolveHuggingFaceToken()).toBe("hub");
    process.env.HUGGINGFACE_TOKEN = "hf";
    expect(resolveHuggingFaceToken()).toBe("hf");
    process.env.HF_TOKEN = "primary";
    expect(resolveHuggingFaceToken()).toBe("primary");
    expect(hasHuggingFaceToken()).toBe(true);
  });

  it("trims whitespace and treats blank values as unset", () => {
    process.env.HF_TOKEN = "   ";
    expect(resolveHuggingFaceToken()).toBe("");
    process.env.HF_TOKEN = "  tok  ";
    expect(resolveHuggingFaceToken()).toBe("tok");
  });

  it("recognizes huggingface.co and its subdomains only", () => {
    expect(isHuggingFaceHost("https://huggingface.co/api/models")).toBe(true);
    expect(
      isHuggingFaceHost("https://cdn-lfs.huggingface.co/repo/file.gguf"),
    ).toBe(true);
    expect(isHuggingFaceHost("https://modelscope.cn/api/models")).toBe(false);
    expect(isHuggingFaceHost("https://huggingface.co.evil.com/x")).toBe(false);
    expect(isHuggingFaceHost("not a url")).toBe(false);
  });

  it("attaches the bearer header only for HF hosts when a token is set", () => {
    process.env.HF_TOKEN = "secret";
    expect(resolveHubAuthHeaders("https://huggingface.co/x")).toEqual({
      authorization: "Bearer secret",
    });
    // Never leak the token to other hosts (ModelScope / mirrors).
    expect(resolveHubAuthHeaders("https://modelscope.cn/x")).toEqual({});
  });

  it("omits the header when no token is configured, even for HF", () => {
    expect(resolveHubAuthHeaders("https://huggingface.co/x")).toEqual({});
  });
});
