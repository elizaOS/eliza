import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/shared", () => ({
  readAliasedEnv: (key: string) => {
    const value = process.env[key] ?? "";
    return value ? value : undefined;
  },
}));

import {
  resolveNamespaceFromEnv,
  resolveRendererUrlFromEnv,
} from "./brand-env-reads.ts";

describe("resolveRendererUrlFromEnv", () => {
  it("prefers ELIZA_RENDERER_URL", () => {
    process.env.ELIZA_RENDERER_URL = "http://renderer";
    expect(resolveRendererUrlFromEnv()).toBe("http://renderer");
    delete process.env.ELIZA_RENDERER_URL;
  });

  it("falls back to VITE_DEV_SERVER_URL then empty", () => {
    delete process.env.ELIZA_RENDERER_URL;
    process.env.VITE_DEV_SERVER_URL = "http://vite";
    expect(resolveRendererUrlFromEnv()).toBe("http://vite");
    delete process.env.VITE_DEV_SERVER_URL;
    expect(resolveRendererUrlFromEnv()).toBe("");
  });
});

describe("resolveNamespaceFromEnv", () => {
  it("uses the env value when set", () => {
    process.env.ELIZA_NAMESPACE = "brand-ns";
    expect(resolveNamespaceFromEnv("default-ns")).toBe("brand-ns");
    delete process.env.ELIZA_NAMESPACE;
  });

  it("falls back to the compiled-in namespace", () => {
    delete process.env.ELIZA_NAMESPACE;
    expect(resolveNamespaceFromEnv("fallback-ns")).toBe("fallback-ns");
  });
});
