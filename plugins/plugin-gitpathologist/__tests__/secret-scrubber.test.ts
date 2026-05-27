import { describe, expect, it } from "vitest";
import { scrubSecrets, scrubSecretsDeep } from "../src/secret-scrubber.ts";

describe("scrubSecrets", () => {
  it("redacts Anthropic keys", () => {
    const input = "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA in env";
    expect(scrubSecrets(input)).toBe("key <REDACTED:ANTHROPIC> in env");
  });

  it("redacts OpenAI keys including project keys", () => {
    expect(scrubSecrets("OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA")).toContain(
      "<REDACTED:OPENAI>"
    );
    expect(scrubSecrets("token sk-AAAAAAAAAAAAAAAAAAAAAAAA done")).toContain("<REDACTED:OPENAI>");
  });

  it("redacts GitHub PATs", () => {
    expect(scrubSecrets("ghp_AAAAAAAAAAAAAAAAAAAAAAAA")).toContain("<REDACTED:GITHUB>");
    expect(scrubSecrets("ghs_AAAAAAAAAAAAAAAAAAAAAAAA")).toContain("<REDACTED:GITHUB>");
  });

  it("redacts AWS access keys", () => {
    expect(scrubSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("<REDACTED:AWS>");
  });

  it("redacts Bearer headers", () => {
    expect(scrubSecrets("Authorization: Bearer abcdef1234567890ABCDEF")).toContain(
      "<REDACTED:BEARER>"
    );
  });

  it("redacts env-name patterns with secret-looking values", () => {
    expect(scrubSecrets('SOME_API_TOKEN="abcdefghijklmnop"')).toContain(
      "SOME_API_TOKEN=<REDACTED:ENV>"
    );
  });

  it("leaves benign text untouched", () => {
    const input = "this is a normal commit message about features";
    expect(scrubSecrets(input)).toBe(input);
  });

  it("returns empty string unchanged", () => {
    expect(scrubSecrets("")).toBe("");
  });
});

describe("scrubSecretsDeep", () => {
  it("walks objects + arrays + strings", () => {
    const result = scrubSecretsDeep({
      name: "x",
      values: ["plain", "sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA"],
      nested: { key: "Bearer abcdef1234567890ABCDEF" },
      count: 5,
    });
    expect(result).toEqual({
      name: "x",
      values: ["plain", "<REDACTED:ANTHROPIC>"],
      nested: { key: "<REDACTED:BEARER>" },
      count: 5,
    });
  });
});
