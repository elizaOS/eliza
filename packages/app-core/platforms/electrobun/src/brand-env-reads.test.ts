/**
 * Proves the Electrobun main-process brand-aliased boot reads (#13422) resolve a
 * NON-ELIZA brand prefix through the alias-aware reader with canonical-`ELIZA_*`
 * precedence and empty-is-unset, and WITHOUT the process.env mirror mutation.
 * Deterministic: seeds the shared BootConfig alias table (as app boot does) and
 * asserts the exact `readAliasedEnv` calls the migrated helpers make.
 */
import {
  buildBrandEnvAliases,
  getBootConfig,
  setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveNamespaceFromEnv,
  resolveRendererUrlFromEnv,
} from "./brand-env-reads";

const BRAND = "MILADY";
const aliases = buildBrandEnvAliases(BRAND);
const savedConfig = getBootConfig();
const tracked = [
  "ELIZA_RENDERER_URL",
  `${BRAND}_RENDERER_URL`,
  "ELIZA_NAMESPACE",
  `${BRAND}_NAMESPACE`,
  "VITE_DEV_SERVER_URL",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of tracked) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Pin the brand<->eliza alias table on the immutable BootConfig, exactly as
  // the app boot path does, so the reader can resolve MILADY_* -> ELIZA_*.
  setBootConfig({ ...savedConfig, envAliases: aliases });
});

afterEach(() => {
  for (const key of tracked) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setBootConfig(savedConfig);
});

describe("resolveRendererUrlFromEnv", () => {
  it("resolves the branded MILADY_RENDERER_URL alias", () => {
    process.env.MILADY_RENDERER_URL = "http://127.0.0.1:5199";
    expect(resolveRendererUrlFromEnv()).toBe("http://127.0.0.1:5199");
  });

  it("prefers canonical ELIZA_RENDERER_URL over the branded alias", () => {
    process.env.ELIZA_RENDERER_URL = "http://canonical:6100";
    process.env.MILADY_RENDERER_URL = "http://branded:6101";
    expect(resolveRendererUrlFromEnv()).toBe("http://canonical:6100");
  });

  it("a blank ELIZA_RENDERER_URL does not mask a present branded alias", () => {
    process.env.ELIZA_RENDERER_URL = "   ";
    process.env.MILADY_RENDERER_URL = "http://branded:6102";
    expect(resolveRendererUrlFromEnv()).toBe("http://branded:6102");
  });

  it("falls through to VITE_DEV_SERVER_URL, then empty string", () => {
    process.env.VITE_DEV_SERVER_URL = "http://vite:5173";
    expect(resolveRendererUrlFromEnv()).toBe("http://vite:5173");
    delete process.env.VITE_DEV_SERVER_URL;
    expect(resolveRendererUrlFromEnv()).toBe("");
  });

  it("performs zero alias writes to process.env while resolving", () => {
    process.env.MILADY_RENDERER_URL = "http://127.0.0.1:5199";
    const before = { ...process.env };
    resolveRendererUrlFromEnv();
    // The migration exists to stop materializing ELIZA_* targets on read.
    expect(process.env.ELIZA_RENDERER_URL).toBeUndefined();
    expect(process.env).toEqual(before);
  });
});

describe("resolveNamespaceFromEnv", () => {
  it("resolves the branded MILADY_NAMESPACE alias", () => {
    process.env.MILADY_NAMESPACE = "milady";
    expect(resolveNamespaceFromEnv("fallback-brand")).toBe("milady");
  });

  it("prefers canonical ELIZA_NAMESPACE over the branded alias", () => {
    process.env.ELIZA_NAMESPACE = "eliza";
    process.env.MILADY_NAMESPACE = "milady";
    expect(resolveNamespaceFromEnv("fallback-brand")).toBe("eliza");
  });

  it("a blank ELIZA_NAMESPACE does not mask a present branded alias", () => {
    process.env.ELIZA_NAMESPACE = "  ";
    process.env.MILADY_NAMESPACE = "milady";
    expect(resolveNamespaceFromEnv("fallback-brand")).toBe("milady");
  });

  it("falls back to the compiled-in brand namespace when unset", () => {
    expect(resolveNamespaceFromEnv("fallback-brand")).toBe("fallback-brand");
  });

  it("performs zero alias writes to process.env while resolving", () => {
    process.env.MILADY_NAMESPACE = "milady";
    const before = { ...process.env };
    resolveNamespaceFromEnv("fallback-brand");
    expect(process.env.ELIZA_NAMESPACE).toBeUndefined();
    expect(process.env).toEqual(before);
  });
});
