/**
 * Behavioral parity between shared's copied redaction sanitizer and the
 * canonical `@elizaos/core` implementation. The copy in
 * `src/settings-debug.ts` exists so the app renderer avoids the prebuilt core
 * browser blob at vite eval time (#18056); it must never drift from core.
 * Real implementations on both sides — no mocks — run over one adversarial
 * fixture set and must produce identical output.
 */
import {
  settingsDebugCloudSummary as coreCloudSummary,
  sanitizeForSettingsDebug as coreSanitize,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  settingsDebugCloudSummary as sharedCloudSummary,
  sanitizeForSettingsDebug as sharedSanitize,
} from "./settings-debug.ts";

/** String subclass whose toString/valueOf lie about the underlying secret. */
class LyingString extends String {
  override toString(): string {
    return "totally-not-a-secret";
  }
  override valueOf(): string {
    return "totally-not-a-secret";
  }
}

/** Builds a self-referencing object; both sides must mark it [circular]. */
function circularFixture(): Record<string, unknown> {
  const node: Record<string, unknown> = {
    name: "loop",
    token: "sk-circular-secret-value-123456",
  };
  node.self = node;
  return node;
}

/** Deeply nested chain that exceeds the sanitizers' max depth. */
function deepFixture(depth: number): Record<string, unknown> {
  const leaf: Record<string, unknown> = { password: "hunter2hunter2" };
  let current: Record<string, unknown> = leaf;
  for (let i = 0; i < depth; i++) {
    current = { level: i, child: current };
  }
  return current;
}

const KEY_VARIANTS: Record<string, unknown> = {
  SECRET: "top-secret-value-that-is-long-enough",
  secret_key: "another-secret-value-that-is-long",
  apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz",
  api_key: "pk_test_abcdefghijklmnopqrstuvwx",
  token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  ACCESS_TOKEN: "short",
  password: "correct horse battery staple",
  PASSWORD: 12345,
  authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
  bearer: true,
  cookie: "session=abc123; theme=dark",
  privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvq\n-----END PRIVATE KEY-----",
  private_key: null,
  mnemonic: "abandon abandon abandon abandon abandon about",
  credential: { inner: "nested-credential-object" },
  sessionKey: ["array", "of", "values"],
  session_id: "",
  my_key: "suffix-underscore-key-should-redact",
  openai_api_key: "sk-proj-1234567890abcdefghijklmn",
  // Non-sensitive names must pass through the generic path on both sides.
  keyboard: "not sensitive despite the prefix",
  monkey: "also not sensitive",
  publicUrl: "https://example.com/callback",
};

const FIXTURES: Array<{ name: string; value: unknown }> = [
  { name: "null", value: null },
  { name: "undefined", value: undefined },
  { name: "boolean", value: true },
  { name: "number", value: 42.5 },
  { name: "bigint", value: 9007199254740993n },
  { name: "empty string", value: "   " },
  { name: "short string", value: "hello" },
  { name: "[REDACTED] passthrough", value: "  [redacted]  " },
  { name: "sk- prefixed short secret", value: "sk-abc" },
  { name: "Bearer header", value: "Bearer abcdefghijklmnop" },
  {
    name: "long opaque string",
    value: "a".repeat(49),
  },
  {
    name: "very long non-secret string",
    value: "word ".repeat(60),
  },
  { name: "named function", value: function loadSettings() {} },
  { name: "anonymous function", value: () => {} },
  { name: "symbol-ish non-object", value: Symbol("s") },
  {
    name: "hostile String subclass under sensitive key",
    value: { apiKey: new LyingString("sk-real-secret-0123456789abcdef") },
  },
  {
    name: "hostile String subclass under plain key",
    value: { label: new LyingString("sk-real-secret-0123456789abcdef") },
  },
  { name: "key-name variants", value: KEY_VARIANTS },
  {
    name: "nested secrets",
    value: {
      cloud: {
        enabled: true,
        auth: {
          apiKey: "sk-nested-1234567890abcdefghij",
          profile: {
            token: "deep-nested-token-value-abcdef",
            displayName: "Alice",
          },
        },
      },
      plugins: [
        { name: "discord", DISCORD_API_TOKEN: "discord-secret-token-value" },
        { name: "plain", retries: 3 },
      ],
    },
  },
  { name: "circular reference", value: circularFixture() },
  { name: "depth overflow", value: deepFixture(20) },
  {
    name: "oversized array",
    value: Array.from({ length: 55 }, (_, i) =>
      i % 2 === 0 ? `item-${i}` : { token: `tok-${i}-abcdefghijklmnop` },
    ),
  },
  {
    name: "mixed-type array",
    value: [1, "two", null, undefined, { secret: "short" }, 3n],
  },
];

describe("settings-debug sanitizer parity (shared copy vs @elizaos/core)", () => {
  for (const fixture of FIXTURES) {
    it(`sanitizes identically: ${fixture.name}`, () => {
      const fromCore = coreSanitize(fixture.value);
      const fromShared = sharedSanitize(fixture.value);
      expect(fromShared).toEqual(fromCore);
      // Serialized comparison catches shape-preserving differences that
      // toEqual tolerates (e.g. String objects vs primitives).
      expect(JSON.stringify(fromShared, jsonBigint)).toBe(
        JSON.stringify(fromCore, jsonBigint),
      );
    });
  }

  it("never leaks raw secret material from either implementation", () => {
    const leaky = {
      apiKey: "sk-real-secret-0123456789abcdef",
      nested: { token: "deep-nested-token-value-abcdef" },
      hostile: new LyingString("sk-real-secret-0123456789abcdef"),
    };
    for (const sanitize of [coreSanitize, sharedSanitize]) {
      const rendered = JSON.stringify(sanitize(leaky), jsonBigint);
      expect(rendered).not.toContain("sk-real-secret-0123456789abcdef");
      expect(rendered).not.toContain("deep-nested-token-value-abcdef");
    }
  });

  it("summarizes cloud slices identically", () => {
    const slices: Array<Record<string, unknown> | null | undefined> = [
      null,
      undefined,
      {},
      {
        enabled: true,
        inferenceMode: "proxy",
        services: ["llm"],
        baseUrl: "https://cloud.example",
        apiKey: "sk-cloud-key-1234567890",
      },
      { enabled: false, apiKey: "   " },
      { apiKey: 123 },
    ];
    for (const slice of slices) {
      expect(sharedCloudSummary(slice)).toEqual(coreCloudSummary(slice));
    }
  });
});

/** JSON replacer so bigint outputs from either side serialize comparably. */
function jsonBigint(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}
