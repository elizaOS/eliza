import { describe, expect, it } from "vitest";
import { redactConfigSecrets } from "../api/server-helpers-config.ts";
import { buildConfigSchema } from "./schema.ts";
import { isSensitiveConfigKey } from "./sensitive-keys.ts";

describe("isSensitiveConfigKey", () => {
  it("covers server redaction and UI-sensitive config names", () => {
    for (const key of [
      "authorization",
      "credential",
      "seed_phrase",
      "seedPhrase",
      "connection_string",
      "connectionString",
      "accessToken",
    ]) {
      expect(isSensitiveConfigKey(key), key).toBe(true);
    }
  });

  it("does not classify non-secret token-count settings", () => {
    expect(isSensitiveConfigKey("maxTokens")).toBe(false);
    expect(isSensitiveConfigKey("models.large.maxTokens")).toBe(false);
  });
});

describe("sensitive config handling", () => {
  it("redacts keys covered by the shared predicate", () => {
    expect(
      redactConfigSecrets({
        seed_phrase: "seed",
        connection_string: "postgres://secret",
        maxTokens: 2048,
      }),
    ).toEqual({
      seed_phrase: "[REDACTED]",
      connection_string: "[REDACTED]",
      maxTokens: 2048,
    });
  });

  it("marks plugin config UI hints sensitive with the same predicate", () => {
    const schema = buildConfigSchema({
      plugins: [
        {
          id: "wallet",
          configUiHints: {
            seed_phrase: { label: "Seed phrase" },
            connection_string: { label: "Connection string" },
            maxTokens: { label: "Max tokens" },
          },
        },
      ],
    });

    expect(
      schema.uiHints["plugins.entries.wallet.config.seed_phrase"]?.sensitive,
    ).toBe(true);
    expect(
      schema.uiHints["plugins.entries.wallet.config.connection_string"]
        ?.sensitive,
    ).toBe(true);
    expect(
      schema.uiHints["plugins.entries.wallet.config.maxTokens"]?.sensitive,
    ).toBeUndefined();
  });
});
