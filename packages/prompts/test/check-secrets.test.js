import assert from "node:assert";
import { describe, it } from "node:test";
import { scanContent } from "../scripts/check-secrets.js";

describe("prompt secret scanner", () => {
  it("flags concrete credential material as errors with source locations", () => {
    const result = scanContent(
      "prompts/example.ts",
      [
        "const key = 'sk-abcdefghijklmnopqrstuvwxyz';",
        "const github = 'ghp_abcdefghijklmnopqrstuvwxyz';",
        "const aws = 'AKIAABCDEFGHIJKLMNOP';",
      ].join("\n"),
    );

    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.errors.length, 3);
    assert.match(result.errors[0], /prompts\/example\.ts:1\s+OpenAI-style key/);
    assert.match(result.errors[1], /prompts\/example\.ts:2\s+GitHub token/);
    assert.match(
      result.errors[2],
      /prompts\/example\.ts:3\s+AWS access key id/,
    );
  });

  it("separates review-only generic assignments from hard failures", () => {
    const result = scanContent(
      "prompts/config.ts",
      [
        "const api = 'example only';",
        "const SERVICE_TOKEN = 'placeholder-token';",
      ].join("\n"),
    );

    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(
      result.warnings[0],
      /prompts\/config\.ts:2\s+Generic credential assignment/,
    );
  });

  it("does not flag plain prompt text that merely names env vars", () => {
    const result = scanContent(
      "prompts/instructions.ts",
      "Tell the user to configure OPENAI_API_KEY in their environment.",
    );

    assert.deepStrictEqual(result, { errors: [], warnings: [] });
  });
});
