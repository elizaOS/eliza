/** Unit tests for the secret-token detector used to gate WRITE/EDIT. */
import { describe, expect, it } from "vitest";
import { detectSecrets } from "./secrets.js";

/** detectSecrets gates WRITE/EDIT against leaking credentials — a security boundary. */

const SAMPLES: Array<{ name: string; content: string }> = [
  { name: "aws_access_key", content: "AKIAIOSFODNN7EXAMPLE" },
  { name: "github_token", content: `ghp_${"a".repeat(36)}` },
  { name: "github_oauth", content: `gho_${"b".repeat(36)}` },
  { name: "github_app", content: `ghs_${"c".repeat(36)}` },
  { name: "openai_key", content: `sk-${"d".repeat(24)}` },
  { name: "anthropic_key", content: `sk-ant-${"e".repeat(95)}` },
  { name: "google_api_key", content: `AIza${"f".repeat(35)}` },
  { name: "slack_token", content: "xoxb-1234567890-abcdef" },
  { name: "stripe_secret", content: `sk_live_${"g".repeat(28)}` },
  { name: "private_key_pem", content: "-----BEGIN RSA PRIVATE KEY-----" },
  {
    name: "jwt_like",
    content: "eyJhbGciOiJxx.eyJzdWIiOiJyy.SflKxwRJSMzz",
  },
];

describe("detectSecrets", () => {
  for (const { name, content } of SAMPLES) {
    it(`flags ${name}`, () => {
      expect(detectSecrets(content).map((m) => m.name)).toContain(name);
    });
  }

  it("returns no matches for benign content", () => {
    expect(detectSecrets("const x = 1; // nothing secret here")).toEqual([]);
    expect(detectSecrets("")).toEqual([]);
  });

  it("masks long secrets in the preview (first 6 … last 4)", () => {
    const [match] = detectSecrets("AKIAIOSFODNN7EXAMPLE");
    expect(match?.name).toBe("aws_access_key");
    expect(match?.preview).toBe("AKIAIO…MPLE");
  });

  it("reports multiple distinct secrets in one blob", () => {
    const names = detectSecrets(
      `aws=AKIAIOSFODNN7EXAMPLE\ngh=ghp_${"a".repeat(36)}\n`,
    ).map((m) => m.name);
    expect(names).toContain("aws_access_key");
    expect(names).toContain("github_token");
  });
});
