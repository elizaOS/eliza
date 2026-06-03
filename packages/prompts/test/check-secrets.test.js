import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scanContent, walkFiles } from "../scripts/check-secrets.js";

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
        "const SERVICE_TOKEN = 'example-token';",
      ].join("\n"),
    );

    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(
      result.warnings[0],
      /prompts\/config\.ts:2\s+Generic credential assignment/,
    );
  });

  it("does not duplicate a hard secret as a generic assignment warning", () => {
    const result = scanContent(
      "prompts/config.ts",
      "const OPENAI_API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz';",
    );

    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /OpenAI-style key/);
    assert.deepStrictEqual(result.warnings, []);
  });

  it("does not flag plain prompt text that merely names env vars", () => {
    const result = scanContent(
      "prompts/instructions.ts",
      "Tell the user to configure OPENAI_API_KEY in their environment.",
    );

    assert.deepStrictEqual(result, { errors: [], warnings: [] });
  });
});

describe("prompt secret scanner file walking", () => {
  it("walks matching files while skipping generated and build output directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-prompts-scan-"));
    try {
      await mkdir(join(root, "src", "prompts"), { recursive: true });
      await mkdir(join(root, "src", "generated"), { recursive: true });
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "src", "prompts", "safe.ts"), "export {};\n");
      await writeFile(join(root, "src", "generated", "ignored.ts"), "x\n");
      await writeFile(join(root, "dist", "ignored.ts"), "x\n");

      const files = await walkFiles(root, (_abs, rel) => rel.endsWith(".ts"));

      assert.deepStrictEqual(
        files.map((file) => file.slice(root.length + 1)).sort(),
        [join("src", "prompts", "safe.ts")],
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
