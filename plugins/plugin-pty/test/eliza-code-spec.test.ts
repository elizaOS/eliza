/**
 * Unit coverage for the pure eliza-code cerebras spawn-spec builder and bin
 * resolver (`lib/eliza-code-spec.ts`): env/model/tier wiring, base-URL defaults,
 * and explicit external binary resolution, driven with an injected `exists`
 * predicate — no real PTY or process spawn.
 */
import path from "node:path";
import { resetDevCloudEnvAuthorityForTests } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildElizaCodeCerebrasSpec,
  ELIZA_CLOUD_DEFAULT_BASE_URL,
  ELIZA_CLOUD_FAST_MODEL,
  ELIZA_CLOUD_SMART_MODEL,
  resolveElizaCodeBin,
  resolveElizaCodeCloudTuple,
} from "../lib/eliza-code-spec";

const AUTHORITY_ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_TARGET",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;
const savedAuthorityEnv = Object.fromEntries(
  AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof AUTHORITY_ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of AUTHORITY_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of AUTHORITY_ENV_KEYS) {
    const value = savedAuthorityEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("buildElizaCodeCerebrasSpec", () => {
  const base = {
    cwd: "/work/repo",
    apiKey: "sk-cloud-123",
    binPath: "/opt/eliza-code/dist/index.js",
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

  it.each(["staging-default", "offline"] as const)(
    "disables the Cloud child lane under %s authority despite caller overrides",
    (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_API_KEY = "inherited-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

      expect(resolveElizaCodeCloudTuple()).toEqual({
        authority,
        enabled: false,
      });
      expect(() =>
        buildElizaCodeCerebrasSpec({
          ...base,
          apiKey: "body-key",
          baseUrl: "https://attacker.example/v1",
          extraEnv: {
            OPENAI_API_KEY: "extra-key",
            OPENAI_BASE_URL: "https://extra.example/v1",
          },
        }),
      ).toThrow(/disabled/i);
    },
  );

  it("projects the frozen explicit staging tuple after late process and child-env overrides", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_API_KEY = "staging-launch-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";

    expect(resolveElizaCodeCloudTuple()).toMatchObject({
      authority: "staging-explicit",
      enabled: true,
      apiKey: "staging-launch-key",
      baseUrl: "https://api-staging.eliza.app/v1",
    });

    process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
    const spec = buildElizaCodeCerebrasSpec({
      ...base,
      apiKey: "body-key",
      baseUrl: "https://attacker.example/v1",
      extraEnv: {
        OPENAI_API_KEY: "extra-key",
        OPENAI_BASE_URL: "https://extra.example/v1",
        ELIZAOS_CLOUD_API_KEY: "alternate-cloud-key",
        PTY_ELIZA_CLOUD_API_KEY: "alternate-pty-key",
      },
    });

    expect(spec.env?.OPENAI_API_KEY).toBe("staging-launch-key");
    expect(spec.env?.OPENAI_BASE_URL).toBe("https://api-staging.eliza.app/v1");
    expect(spec.env?.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(spec.env?.PTY_ELIZA_CLOUD_API_KEY).toBeUndefined();
  });

  it("keeps a self-hosted launch tuple after the live env is cleared", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "self-hosted";
    process.env.ELIZAOS_CLOUD_API_KEY = "selfhost-launch-key";
    process.env.ELIZAOS_CLOUD_BASE_URL =
      "https://cloud.internal.example/api/v1";
    expect(resolveElizaCodeCloudTuple().enabled).toBe(true);

    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    const spec = buildElizaCodeCerebrasSpec({
      ...base,
      apiKey: "late-body-key",
      baseUrl: "https://api.eliza.app/v1",
    });

    expect(spec.env?.OPENAI_API_KEY).toBe("selfhost-launch-key");
    expect(spec.env?.OPENAI_BASE_URL).toBe("https://cloud.internal.example/v1");
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

  it("rejects a relative ELIZA_CODE_BIN path", () => {
    expect(() =>
      resolveElizaCodeBin({
        env: { ELIZA_CODE_BIN: "bin/eliza-code.js" },
        exists: () => true,
      }),
    ).toThrow(/absolute path/i);
  });

  it("requires an explicitly configured external binary", () => {
    expect(() => resolveElizaCodeBin({ env: {}, exists: () => false })).toThrow(
      /must be set/i,
    );
  });
});
