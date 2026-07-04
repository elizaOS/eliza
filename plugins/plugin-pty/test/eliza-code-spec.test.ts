/**
 * Unit coverage for the pure eliza-code cerebras spawn-spec builder and bin
 * resolver (`lib/eliza-code-spec.ts`): env/model/tier wiring, base-URL defaults,
 * and resolver override + workspace walk-up, driven with an injected `exists`
 * predicate — no real PTY or process spawn.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildElizaCodeCerebrasSpec,
  ELIZA_CLOUD_DEFAULT_BASE_URL,
  ELIZA_CLOUD_FAST_MODEL,
  ELIZA_CLOUD_SMART_MODEL,
  resolveElizaCodeBin,
} from "../lib/eliza-code-spec";

describe("buildElizaCodeCerebrasSpec", () => {
  const base = {
    cwd: "/work/repo",
    apiKey: "sk-cloud-123",
    binPath: "/abs/packages/examples/code/dist/index.js",
  };

  it("launches the interactive binary via bun, in the given cwd", () => {
    const spec = buildElizaCodeCerebrasSpec(base);
    expect(spec.command).toBe("bun");
    expect(spec.args).toEqual([base.binPath, "--interactive", "--coding-only"]);
    expect(spec.cwd).toBe(path.resolve("/work/repo"));
    expect(spec.kind).toBe("eliza-code");
  });

  it("points eliza-code at Eliza Cloud/cerebras via OpenAI-compatible env", () => {
    const spec = buildElizaCodeCerebrasSpec(base);
    expect(spec.env).toMatchObject({
      ELIZA_CODE_PROVIDER: "openai",
      ELIZA_CODE_CODING_ONLY: "1",
      OPENAI_API_KEY: "sk-cloud-123",
      OPENAI_BASE_URL: ELIZA_CLOUD_DEFAULT_BASE_URL,
      OPENAI_SMALL_MODEL: ELIZA_CLOUD_FAST_MODEL,
      OPENAI_MEDIUM_MODEL: ELIZA_CLOUD_FAST_MODEL,
      OPENAI_LARGE_MODEL: ELIZA_CLOUD_SMART_MODEL,
      CODING_TOOLS_WORKSPACE_ROOTS: path.resolve("/work/repo"),
      SHELL_ALLOWED_DIRECTORY: path.resolve("/work/repo"),
    });
  });

  it("fast tier keeps small=fast; smart tier promotes small to the smart model", () => {
    const fast = buildElizaCodeCerebrasSpec({ ...base, tier: "fast" });
    expect(fast.env?.OPENAI_SMALL_MODEL).toBe(ELIZA_CLOUD_FAST_MODEL);
    expect(fast.env?.OPENAI_LARGE_MODEL).toBe(ELIZA_CLOUD_SMART_MODEL);
    expect(fast.label).toContain("fast");

    const smart = buildElizaCodeCerebrasSpec({ ...base, tier: "smart" });
    expect(smart.env?.OPENAI_SMALL_MODEL).toBe(ELIZA_CLOUD_SMART_MODEL);
    expect(smart.env?.OPENAI_LARGE_MODEL).toBe(ELIZA_CLOUD_SMART_MODEL);
    expect(smart.label).toContain("smart");
  });

  it("honors base URL / model / runner overrides and extra env", () => {
    const spec = buildElizaCodeCerebrasSpec({
      ...base,
      baseUrl: "https://staging.example/v1",
      fastModel: "fast-x",
      smartModel: "smart-y",
      runner: "node",
      extraEnv: { FOO: "bar" },
    });
    expect(spec.command).toBe("node");
    expect(spec.env).toMatchObject({
      OPENAI_BASE_URL: "https://staging.example/v1",
      OPENAI_SMALL_MODEL: "fast-x",
      OPENAI_LARGE_MODEL: "smart-y",
      FOO: "bar",
    });
  });

  it("rejects missing apiKey / cwd / binPath with a clear message", () => {
    expect(() => buildElizaCodeCerebrasSpec({ ...base, apiKey: "  " })).toThrow(
      /API key/i,
    );
    expect(() => buildElizaCodeCerebrasSpec({ ...base, cwd: "" })).toThrow(
      /cwd/i,
    );
    expect(() => buildElizaCodeCerebrasSpec({ ...base, binPath: "" })).toThrow(
      /binPath/i,
    );
  });
});

describe("resolveElizaCodeBin", () => {
  it("uses ELIZA_CODE_BIN when it points at an existing file", () => {
    const resolved = resolveElizaCodeBin({
      env: { ELIZA_CODE_BIN: "/custom/eliza-code.js" },
      exists: (p) => p === "/custom/eliza-code.js",
    });
    expect(resolved).toBe(path.resolve("/custom/eliza-code.js"));
  });

  it("throws when ELIZA_CODE_BIN points at a missing file", () => {
    expect(() =>
      resolveElizaCodeBin({
        env: { ELIZA_CODE_BIN: "/missing.js" },
        exists: () => false,
      }),
    ).toThrow(/no file exists/i);
  });

  it("walks up to find packages/examples/code/dist/index.js", () => {
    const want = path.join(
      "/repo",
      "packages",
      "examples",
      "code",
      "dist",
      "index.js",
    );
    const resolved = resolveElizaCodeBin({
      env: {},
      startDir: "/repo/plugins/plugin-pty",
      exists: (p) => p === want,
    });
    expect(resolved).toBe(want);
  });

  it("throws actionable guidance when the bundle is not built", () => {
    expect(() =>
      resolveElizaCodeBin({ env: {}, startDir: "/repo", exists: () => false }),
    ).toThrow(/Build it with/i);
  });
});
