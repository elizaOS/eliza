/**
 * Exercises plugin configuration and resolved runtime-context validation through
 * the real helpers, including environment fallback, diagnostics, depth limits,
 * serialization failures, and structured debug output.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  debugLogResolvedContext,
  type PluginParamInfo,
  validatePluginConfig,
  validateRuntimeContext,
} from "./plugin-validation";

const requiredKey = (
  overrides: Partial<PluginParamInfo> = {},
): PluginParamInfo => ({
  key: "OPENAI_API_KEY",
  required: true,
  sensitive: true,
  type: "string",
  description: "OpenAI API key",
  ...overrides,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validatePluginConfig", () => {
  it("rejects undeclared keys and reports casing mistakes separately", () => {
    const result = validatePluginConfig(
      "openai",
      "model-provider",
      null,
      ["OPENAI_API_KEY"],
      {
        openai_api_key: "sk-valid-value",
        UNKNOWN_KEY: "value",
      },
    );

    expect(result).toEqual({
      valid: false,
      errors: [
        {
          field: "openai_api_key",
          message:
            "openai_api_key does not match declared config key casing; use OPENAI_API_KEY",
        },
        {
          field: "UNKNOWN_KEY",
          message: "UNKNOWN_KEY is not a declared config key for this plugin",
        },
      ],
      warnings: [],
    });
  });

  it("checks every required parameter while ignoring optional parameters", () => {
    vi.stubEnv("OPENAI_API_KEY", "");

    const result = validatePluginConfig(
      "openai",
      "model-provider",
      null,
      ["OPENAI_API_KEY", "OPTIONAL_MODEL"],
      undefined,
      [
        requiredKey(),
        requiredKey({
          key: "OPTIONAL_MODEL",
          required: false,
          sensitive: false,
        }),
      ],
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        field: "OPENAI_API_KEY",
        message: "OPENAI_API_KEY is required but not set",
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("uses provided values before environment values", () => {
    vi.stubEnv("OPENAI_API_KEY", "invalid-environment-value");

    expect(
      validatePluginConfig(
        "openai",
        "model-provider",
        null,
        ["OPENAI_API_KEY"],
        { OPENAI_API_KEY: "sk-provided-value" },
        [requiredKey()],
      ),
    ).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("warns for a missing required parameter that declares a default", () => {
    vi.stubEnv("DEFAULT_MODEL", "   ");

    const result = validatePluginConfig(
      "provider",
      "model-provider",
      null,
      ["DEFAULT_MODEL"],
      undefined,
      [
        requiredKey({
          key: "DEFAULT_MODEL",
          sensitive: false,
          default: "model-v1",
        }),
      ],
    );

    expect(result).toEqual({
      valid: true,
      errors: [],
      warnings: [
        {
          field: "DEFAULT_MODEL",
          message: "DEFAULT_MODEL is not set (will use default: model-v1)",
        },
      ],
    });
  });

  it("reports both format and length warnings for a short sensitive key", () => {
    const result = validatePluginConfig(
      "anthropic",
      "model-provider",
      null,
      ["ANTHROPIC_API_KEY"],
      { ANTHROPIC_API_KEY: "bad" },
      [requiredKey({ key: "ANTHROPIC_API_KEY" })],
    );

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([
      {
        field: "ANTHROPIC_API_KEY",
        message:
          'Anthropic key should start with "sk-ant-" — the current value may be invalid',
      },
      {
        field: "ANTHROPIC_API_KEY",
        message: "ANTHROPIC_API_KEY looks too short (3 chars)",
      },
    ]);
  });

  it("uses the legacy environment-key fallback when parameter definitions are absent", () => {
    vi.stubEnv("GROQ_API_KEY", "tiny");

    expect(
      validatePluginConfig("groq", "model-provider", "GROQ_API_KEY", [
        "GROQ_API_KEY",
      ]),
    ).toEqual({
      valid: true,
      errors: [],
      warnings: [
        {
          field: "GROQ_API_KEY",
          message:
            'Groq key should start with "gsk_" — the current value may be invalid',
        },
        {
          field: "GROQ_API_KEY",
          message: "GROQ_API_KEY looks too short (4 chars)",
        },
      ],
    });
  });

  it("requires the legacy environment key but accepts plugins with no declared key", () => {
    vi.stubEnv("LEGACY_TOKEN", " ");

    expect(
      validatePluginConfig("legacy", "integration", "LEGACY_TOKEN", [
        "LEGACY_TOKEN",
      ]),
    ).toMatchObject({
      valid: false,
      errors: [
        {
          field: "LEGACY_TOKEN",
          message: "LEGACY_TOKEN is required but not set",
        },
      ],
    });
    expect(
      validatePluginConfig("local", "utility", null, [], undefined, []),
    ).toEqual({ valid: true, errors: [], warnings: [] });
  });
});

describe("validateRuntimeContext", () => {
  it("reports nested null, undefined, and whitespace-only fields in traversal order", () => {
    const result = validateRuntimeContext({
      nullValue: null,
      nested: {
        undefinedValue: undefined,
        emptyValue: "  ",
        populatedValue: "ready",
      },
    });

    expect(result).toEqual({
      valid: false,
      serializable: true,
      nullFields: ["nullValue"],
      undefinedFields: ["nested.undefinedValue"],
      emptyFields: ["nested.emptyValue"],
      nonSerializableFields: [],
    });
  });

  it("classifies functions, symbols, and bigints as non-serializable", () => {
    const result = validateRuntimeContext({
      callback: () => undefined,
      marker: Symbol("marker"),
      count: 1n,
    });

    expect(result).toEqual({
      valid: true,
      serializable: false,
      nullFields: [],
      undefinedFields: [],
      emptyFields: [],
      nonSerializableFields: ["callback", "marker", "count"],
    });
  });

  it("honors the maximum depth without treating arrays, dates, or regexps as records", () => {
    const result = validateRuntimeContext(
      {
        levelOne: { levelTwo: { omitted: null } },
        values: [null, undefined],
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        matcher: /plugin/,
      },
      1,
    );

    expect(result).toEqual({
      valid: true,
      serializable: true,
      nullFields: [],
      undefinedFields: [],
      emptyFields: [],
      nonSerializableFields: [],
    });
  });

  it("detects serialization failures that are not direct field-type failures", () => {
    const context: Record<string, unknown> = {};
    context.self = context;

    const result = validateRuntimeContext(context, 0);

    expect(result.valid).toBe(true);
    expect(result.serializable).toBe(false);
    expect(result.nonSerializableFields).toEqual([]);
  });
});

describe("debugLogResolvedContext", () => {
  it("logs plugin and provider ordering followed by a passing validation summary", () => {
    const messages: string[] = [];

    debugLogResolvedContext(
      ["plugin-b", "plugin-a"],
      ["provider-z"],
      { ready: true },
      (message) => messages.push(message),
    );

    expect(messages).toEqual([
      "[eliza:debug] ══════ Resolved Plugin/Provider Context ══════",
      "[eliza:debug] Plugins loaded (2):",
      "[eliza:debug]   • plugin-b",
      "[eliza:debug]   • plugin-a",
      "[eliza:debug] Providers loaded (1):",
      "[eliza:debug]   • provider-z",
      "[eliza:debug] Context validation: ✓ PASS (all fields valid, serializable)",
      "[eliza:debug] ══════════════════════════════════════════════",
    ]);
  });

  it("logs every populated issue category", () => {
    const messages: string[] = [];

    debugLogResolvedContext(
      [],
      [],
      {
        missing: null,
        absent: undefined,
        blank: "",
        callback: () => undefined,
      },
      (message) => messages.push(message),
    );

    expect(messages).toContain(
      "[eliza:debug] Context validation: ✗ ISSUES DETECTED",
    );
    expect(messages).toContain("[eliza:debug]   null fields: missing");
    expect(messages).toContain("[eliza:debug]   undefined fields: absent");
    expect(messages).toContain("[eliza:debug]   empty fields: blank");
    expect(messages).toContain(
      "[eliza:debug]   non-serializable fields: callback",
    );
  });
});
