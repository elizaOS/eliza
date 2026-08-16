/**
 * Filesystem-backed coverage for corpus target validation. The harness writes
 * synthetic manifests and shards to temporary directories without mocks.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCorpusManifest, validateCorpusTarget } from "./validator.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "corpus-validator-test-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("validateCorpusTarget", () => {
  it.each([
    ["truncated object", "{"],
    ["empty file", ""],
    ["trailing comma", '{"schemaVersion":1,}'],
    ["extra tokens", "{} trailing"],
    ["UTF-8 BOM", `${String.fromCharCode(0xfeff)}{}`],
  ])(
    "returns a structured issue for malformed manifest JSON: %s",
    async (_, raw) => {
      const targetPath = await makeTempDir();
      const manifestPath = path.join(targetPath, "manifest.json");
      await fs.writeFile(manifestPath, raw, "utf8");

      const result = await validateCorpusTarget(targetPath);

      expect(result.ok).toBe(false);
      expect(result.manifest.totals.messages).toBe(0);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        path: manifestPath,
        code: "manifest-invalid",
      });
      expect(result.issues[0]?.message).toEqual(expect.any(String));
      expect(result.issues[0]?.message.length).toBeGreaterThan(0);
    },
  );

  it("keeps valid JSON schema failures as structured manifest issues", async () => {
    const targetPath = await makeTempDir();
    const manifestPath = path.join(targetPath, "manifest.json");
    await fs.writeFile(manifestPath, '"not-an-object"', "utf8");

    const result = await validateCorpusTarget(targetPath);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: manifestPath,
        code: "manifest-invalid",
      }),
    ]);
  });

  it("accepts a valid manifest matching the rebuilt shard inventory", async () => {
    const targetPath = await makeTempDir();
    const { manifest } = await buildCorpusManifest(
      targetPath,
      "2026-08-16T00:00:00.000Z",
    );
    await fs.writeFile(
      path.join(targetPath, "manifest.json"),
      JSON.stringify(manifest),
      "utf8",
    );

    const result = await validateCorpusTarget(targetPath);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("preserves structured JSONL parse issues while rebuilding the manifest", async () => {
    const targetPath = await makeTempDir();
    const shardPath = path.join(targetPath, "x", "1234", "2024-08.jsonl");
    await fs.mkdir(path.dirname(shardPath), { recursive: true });
    await fs.writeFile(shardPath, "{\n", "utf8");

    const result = await validateCorpusTarget(targetPath);

    expect(result.ok).toBe(false);
    expect(result.manifest.totals.messages).toBe(0);
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: shardPath,
        line: 1,
        code: "schema-invalid",
      }),
    ]);
  });
});
