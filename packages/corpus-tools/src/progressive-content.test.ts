/**
 * Exercises the real streamed progressive-content generator and its manifest
 * as a deterministic checksum, coordinate, authorization, and scale oracle.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateProgressiveContentCorpus,
  PROGRESSIVE_CONTENT_BOUNDARY_BYTES,
  progressiveContentObjectId,
} from "./progressive-content.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "progressive-content-corpus-"),
  );
  roots.push(root);
  return root;
}

describe("progressive content corpus", () => {
  it("derives family-stable identifiers without cross-family perturbation", () => {
    expect(progressiveContentObjectId("seed", "file", 3)).toBe(
      progressiveContentObjectId("seed", "file", 3),
    );
    expect(progressiveContentObjectId("seed", "file", 3)).not.toBe(
      progressiveContentObjectId("seed", "email", 3),
    );
    expect(() => progressiveContentObjectId("seed", "file", -1)).toThrow(
      RangeError,
    );
  });

  it("generates a deterministic 20-object micro corpus with exact canary ranges", async () => {
    const firstRoot = await makeRoot();
    const secondRoot = await makeRoot();
    const first = await generateProgressiveContentCorpus({
      outDir: firstRoot,
      profile: "micro",
      rootSeed: "progressive-test-seed",
      generatorRevision: "test-revision",
    });
    const second = await generateProgressiveContentCorpus({
      outDir: secondRoot,
      profile: "micro",
      rootSeed: "progressive-test-seed",
      generatorRevision: "test-revision",
    });

    expect(first.objects).toHaveLength(20);
    expect(first.logicalBytes).toBeLessThan(2 * 1024 * 1024);
    expect(second).toEqual(first);
    expect(new Set(first.objects.map((object) => object.family))).toEqual(
      new Set([
        "file",
        "document",
        "memory",
        "email",
        "attachment",
        "tool-output",
      ]),
    );
    expect(new Set(first.objects.map((object) => object.format))).toEqual(
      new Set([
        "lf-lines",
        "crlf-lines",
        "no-final-newline",
        "single-line",
        "minified-json-like",
        "invalid-utf8",
      ]),
    );

    for (const object of first.objects) {
      const bytes = await readFile(path.join(firstRoot, object.relativePath));
      expect(bytes).toHaveLength(object.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        object.sourceSha256,
      );
      for (const canary of object.canaries) {
        expect(
          bytes.subarray(canary.byteStart, canary.byteEnd).toString(),
        ).toBe(canary.text);
      }
      if (object.format === "invalid-utf8" && object.byteLength > 256) {
        expect(() =>
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ).toThrow();
      }
      if (object.format === "crlf-lines" && object.byteLength > 256) {
        expect(bytes.includes(Buffer.from("\r\n"))).toBe(true);
      }
      if (object.format === "no-final-newline" && object.byteLength > 0) {
        expect(bytes.at(-1)).not.toBe(0x0a);
      }
    }
  });

  it("plans every required byte boundary in non-micro profiles", async () => {
    const root = await makeRoot();
    const manifest = await generateProgressiveContentCorpus({
      outDir: root,
      profile: "pr",
      rootSeed: "boundary-plan-seed",
      generatorRevision: "test-revision",
    });
    const fileSizes = new Set(
      manifest.objects
        .filter((object) => object.family === "file")
        .map((object) => object.byteLength),
    );
    for (const boundary of PROGRESSIVE_CONTENT_BOUNDARY_BYTES) {
      expect(fileSizes.has(boundary)).toBe(true);
    }
  }, 60_000);

  it("changes manifest identity when the root seed changes", async () => {
    const first = await generateProgressiveContentCorpus({
      outDir: await makeRoot(),
      rootSeed: "seed-a",
      generatorRevision: "test-revision",
    });
    const second = await generateProgressiveContentCorpus({
      outDir: await makeRoot(),
      rootSeed: "seed-b",
      generatorRevision: "test-revision",
    });
    expect(first.manifestSha256).not.toBe(second.manifestSha256);
    expect(first.objects[0]?.id).not.toBe(second.objects[0]?.id);
  });
});
