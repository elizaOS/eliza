/**
 * Behavioral coverage for plugin ↔ core version-compat helpers: semver parse
 * and compare (including ties, empty input, and pre-release ordering) plus
 * diagnoseNoAIProvider branches. Drives the real module; no mocks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AI_PROVIDER_PLUGINS,
  compareSemver,
  diagnoseNoAIProvider,
  parseSemver,
} from "./version-compat.ts";

const CONFIG_DIAGNOSTIC =
  "No AI provider plugin was loaded. Set an API key environment variable " +
  "(e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY) or log in " +
  "to Eliza Cloud (ELIZAOS_CLOUD_API_KEY) to enable at least one model provider.";

const SUPPRESS_ENV_KEYS = [
  "ELIZA_LOCAL_LLAMA",
  "ELIZA_DEVICE_BRIDGE_ENABLED",
  "ELIZA_ALLOW_NO_PROVIDER",
] as const;

const originalSuppressEnv: Record<
  (typeof SUPPRESS_ENV_KEYS)[number],
  string | undefined
> = {
  ELIZA_LOCAL_LLAMA: undefined,
  ELIZA_DEVICE_BRIDGE_ENABLED: undefined,
  ELIZA_ALLOW_NO_PROVIDER: undefined,
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  for (const key of SUPPRESS_ENV_KEYS) {
    originalSuppressEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SUPPRESS_ENV_KEYS) {
    restoreEnv(key, originalSuppressEnv[key]);
  }
});

describe("AI_PROVIDER_PLUGINS", () => {
  it("lists the known AI provider package names in declaration order", () => {
    expect([...AI_PROVIDER_PLUGINS]).toEqual([
      "@elizaos/plugin-anthropic",
      "@elizaos/plugin-openai",
      "@elizaos/plugin-openrouter",
      "@elizaos/plugin-zerollama",
      "@elizaos/plugin-google-genai",
      "@elizaos/plugin-groq",
      "@elizaos/plugin-xai",
      "@elizaos/plugin-zai",
      "@elizaos/plugin-elizacloud",
      "@elizaos/plugin-codex-cli",
      "@elizaos/plugin-cli-inference",
      "@elizaos/plugin-nearai",
      "@elizaos/plugin-vercel-ai-gateway",
    ]);
  });
});

describe("parseSemver", () => {
  it("parses a stable release as sorting after any pre-release", () => {
    expect(parseSemver("2.0.0")).toEqual([2, 0, 0, Number.POSITIVE_INFINITY]);
  });

  it("parses beta, rc, and nightly numeric suffixes", () => {
    expect(parseSemver("2.0.0-beta.0")).toEqual([2, 0, 0, 0]);
    expect(parseSemver("2.0.0-beta.1")).toEqual([2, 0, 0, 1]);
    expect(parseSemver("1.2.3-rc.4")).toEqual([1, 2, 3, 4]);
    expect(parseSemver("2.0.0-nightly.20260208")).toEqual([2, 0, 0, 20260208]);
  });

  it("returns null for empty and unparseable versions", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("1.2.3.4")).toBeNull();
    expect(parseSemver("v2.0.0")).toBeNull();
    expect(parseSemver("2.0.0-alpha.1")).toBeNull();
    expect(parseSemver("2.0.0-beta")).toBeNull();
    expect(parseSemver("2.0.0-BETA.1")).toBeNull();
    expect(parseSemver("2.0.0-beta.x")).toBeNull();
    expect(parseSemver("2.0.0+build.1")).toBeNull();
    expect(parseSemver(" 2.0.0")).toBeNull();
    expect(parseSemver("2.0.0 ")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("returns 0 for identical parseable versions (tie)", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("2.0.0-beta.1", "2.0.0-beta.1")).toBe(0);
  });

  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.0.0")).toBe(1);
    expect(compareSemver("1.1.0", "1.2.0")).toBe(-1);
    expect(compareSemver("1.2.0", "1.1.0")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
  });

  it("orders a stable release after any matching pre-release", () => {
    expect(compareSemver("2.0.0-beta.9", "2.0.0")).toBe(-1);
    expect(compareSemver("2.0.0", "2.0.0-rc.1")).toBe(1);
    expect(compareSemver("2.0.0-nightly.20260208", "2.0.0")).toBe(-1);
  });

  it("orders pre-release numeric suffixes within the same channel", () => {
    expect(compareSemver("2.0.0-beta.0", "2.0.0-beta.1")).toBe(-1);
    expect(compareSemver("2.0.0-beta.1", "2.0.0-beta.0")).toBe(1);
  });

  it("compares only the numeric suffix across pre-release tag types", () => {
    // Observed: beta.1 and rc.1 both parse as [2,0,0,1], so they tie.
    expect(compareSemver("2.0.0-beta.1", "2.0.0-rc.1")).toBe(0);
    expect(compareSemver("2.0.0-beta.2", "2.0.0-rc.1")).toBe(1);
    expect(compareSemver("2.0.0-nightly.1", "2.0.0-beta.1")).toBe(0);
  });

  it("returns null when either side is unparseable, including empty input", () => {
    expect(compareSemver("", "1.0.0")).toBeNull();
    expect(compareSemver("1.0.0", "")).toBeNull();
    expect(compareSemver("latest", "1.0.0")).toBeNull();
    expect(compareSemver("1.0.0", "v1.0.0")).toBeNull();
    expect(compareSemver("not-a-version", "also-not")).toBeNull();
  });
});

describe("diagnoseNoAIProvider", () => {
  it("returns null when a listed AI provider package loaded (single element)", () => {
    expect(diagnoseNoAIProvider(["@elizaos/plugin-openai"], [])).toBeNull();
  });

  it("returns null when any listed AI provider loaded among other plugins", () => {
    expect(
      diagnoseNoAIProvider(
        ["@elizaos/plugin-sql", "@elizaos/plugin-anthropic"],
        [{ name: "@elizaos/plugin-openai", error: "boom" }],
      ),
    ).toBeNull();
  });

  it("returns null when a loaded name is a known AI provider alias", () => {
    expect(diagnoseNoAIProvider(["elizaOSCloud"], [])).toBeNull();
    expect(diagnoseNoAIProvider(["codex-cli"], [])).toBeNull();
  });

  it("returns null for each listed AI provider package when it is the only loaded name", () => {
    for (const name of AI_PROVIDER_PLUGINS) {
      expect(diagnoseNoAIProvider([name], [])).toBeNull();
    }
  });

  it("returns the configuration diagnostic for empty loaded and failed queues", () => {
    expect(diagnoseNoAIProvider([], [])).toBe(CONFIG_DIAGNOSTIC);
  });

  it("returns the configuration diagnostic when only non-AI plugins loaded and none failed", () => {
    expect(diagnoseNoAIProvider(["@elizaos/plugin-sql"], [])).toBe(
      CONFIG_DIAGNOSTIC,
    );
  });

  it("ignores failed non-AI plugins and still reports a configuration issue", () => {
    expect(
      diagnoseNoAIProvider(
        [],
        [{ name: "@elizaos/plugin-sql", error: "not found in module" }],
      ),
    ).toBe(CONFIG_DIAGNOSTIC);
  });

  it("does not treat a failed alias name as an AI provider failure", () => {
    // Observed: failed-plugin matching uses package names only, not aliases.
    expect(
      diagnoseNoAIProvider(
        [],
        [{ name: "elizaOSCloud", error: "not found in module" }],
      ),
    ).toBe(CONFIG_DIAGNOSTIC);
  });

  it("returns the version-skew diagnostic when a failed AI provider matches an export-missing signature", () => {
    const message = diagnoseNoAIProvider(
      [],
      [
        {
          name: "@elizaos/plugin-openai",
          error: "Export named 'foo' not found in module",
        },
      ],
    );
    expect(message).toContain("Version skew detected: @elizaos/plugin-openai");
    expect(message).toContain(
      "failed to import required symbols from @elizaos/core",
    );
    expect(message).toContain("https://github.com/elizaos/eliza/issues/10");
  });

  it("joins multiple version-skew plugin names and matches each signature substring", () => {
    const message = diagnoseNoAIProvider(
      [],
      [
        {
          name: "@elizaos/plugin-openai",
          error: "not found in module './types'",
        },
        {
          name: "@elizaos/plugin-anthropic",
          error: "does not provide an export named 'bar'",
        },
        {
          name: "@elizaos/plugin-xai",
          error: "network timeout",
        },
      ],
    );
    expect(message).toContain(
      "Version skew detected: @elizaos/plugin-openai, @elizaos/plugin-anthropic",
    );
    expect(message).not.toContain("@elizaos/plugin-xai");
  });

  it("returns the generic failure diagnostic when AI providers failed without a skew signature", () => {
    expect(
      diagnoseNoAIProvider(
        [],
        [
          { name: "@elizaos/plugin-openai", error: "ENOENT: missing key" },
          { name: "@elizaos/plugin-xai", error: "401 unauthorized" },
        ],
      ),
    ).toBe(
      "All AI provider plugins failed to load:\n" +
        "  @elizaos/plugin-openai: ENOENT: missing key\n" +
        "  @elizaos/plugin-xai: 401 unauthorized",
    );
  });

  it.each(SUPPRESS_ENV_KEYS)(
    "returns null when %s is the trimmed string 1 even with no providers",
    (key) => {
      process.env[key] = " 1 ";
      expect(diagnoseNoAIProvider([], [])).toBeNull();
    },
  );

  it("does not suppress the diagnostic for other truthy env values", () => {
    process.env.ELIZA_LOCAL_LLAMA = "true";
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "0";
    process.env.ELIZA_ALLOW_NO_PROVIDER = "";
    expect(diagnoseNoAIProvider([], [])).toBe(CONFIG_DIAGNOSTIC);
  });
});
