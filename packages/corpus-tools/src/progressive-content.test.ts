/**
 * Exercises the real streamed progressive-content generator and its manifest
 * as a deterministic checksum, coordinate, authorization, and scale oracle.
 */

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateProgressiveContentCorpus,
  PROGRESSIVE_CONTENT_BOUNDARY_BYTES,
  progressiveContentObjectId,
  verifyProgressiveContentCorpus,
} from "./progressive-content.ts";
import { extractProgressiveFormatFixture } from "./progressive-content-formats.ts";

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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function signManifest(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const { manifestSha256: _prior, ...unsigned } = record;
  return {
    ...unsigned,
    manifestSha256: createHash("sha256")
      .update(canonicalJson(unsigned))
      .digest("hex"),
  };
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

  it("generates deterministic real-format fixtures with mechanical extraction oracles", async () => {
    const root = await makeRoot();
    const manifest = await generateProgressiveContentCorpus({
      outDir: root,
      rootSeed: "real-format-seed",
      generatorRevision: "test-revision",
    });

    expect(manifest.formatFixtures.map((fixture) => fixture.kind)).toEqual([
      "markdown",
      "html",
      "csv",
      "jsonl",
      "pdf-text",
      "docx",
      "mime-nested",
      "ocr-required",
      "extraction-failed",
    ]);
    for (const fixture of manifest.formatFixtures) {
      const bytes = await readFile(path.join(root, fixture.relativePath));
      expect(bytes.byteLength).toBe(fixture.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        fixture.sourceSha256,
      );
    }

    const pdf = manifest.formatFixtures.find(
      (fixture) => fixture.kind === "pdf-text",
    );
    if (!pdf) throw new Error("expected text PDF fixture");
    const pdfText = (
      await readFile(path.join(root, pdf.relativePath), "latin1")
    ).toString();
    expect(pdfText.startsWith("%PDF-1.4")).toBe(true);
    expect(pdfText.match(/\/Type \/Page\b/gu)).toHaveLength(3);
    expect(pdfText).toContain("CANARY-PDF-LAST-95");

    const docx = manifest.formatFixtures.find(
      (fixture) => fixture.kind === "docx",
    );
    if (!docx) throw new Error("expected DOCX fixture");
    const archive = unzipSync(
      await readFile(path.join(root, docx.relativePath)),
    );
    expect(new TextDecoder().decode(archive["word/document.xml"])).toContain(
      "CANARY-DOCX-END-96",
    );

    const mime = manifest.formatFixtures.find(
      (fixture) => fixture.kind === "mime-nested",
    );
    if (!mime) throw new Error("expected MIME fixture");
    const mimeText = await readFile(path.join(root, mime.relativePath), "utf8");
    expect(mimeText).toContain("multipart/alternative");
    expect(mimeText).toContain("Content-Transfer-Encoding: base64");
    expect(mimeText).toContain("CANARY-MIME-LATE-97");
    expect(
      manifest.formatFixtures.find((fixture) => fixture.kind === "ocr-required")
        ?.expectedState,
    ).toBe("ocr-required");
    expect(
      manifest.formatFixtures.find(
        (fixture) => fixture.kind === "extraction-failed",
      )?.expectedState,
    ).toBe("failed");
  });

  it("publishes owner-only files and rejects an unsafe existing mode", async () => {
    const root = await makeRoot();
    const first = await generateProgressiveContentCorpus({
      outDir: root,
      rootSeed: "private-mode-seed",
      generatorRevision: "test-revision",
    });
    const fixture = first.formatFixtures[0];
    if (!fixture) throw new Error("expected a format fixture");
    const target = path.join(root, fixture.relativePath);
    expect((await lstat(target)).mode & 0o077).toBe(0);
    expect((await lstat(path.join(root, "manifest.json"))).mode & 0o077).toBe(
      0,
    );
    await chmod(target, 0o644);

    await expect(
      generateProgressiveContentCorpus({
        outDir: root,
        rootSeed: "private-mode-seed",
        generatorRevision: "test-revision",
      }),
    ).rejects.toMatchObject({
      code: "PROGRESSIVE_CONTENT_PERMISSIONS_REJECTED",
    });
  });

  it("refuses a planted artifact symlink without modifying its victim", async () => {
    const root = await makeRoot();
    const victimRoot = await makeRoot();
    const first = await generateProgressiveContentCorpus({
      outDir: root,
      rootSeed: "symlink-seed",
      generatorRevision: "test-revision",
    });
    const fixture = first.formatFixtures[0];
    if (!fixture) throw new Error("expected a format fixture");
    const victim = path.join(victimRoot, "victim.txt");
    await writeFile(victim, "DO NOT CHANGE", { mode: 0o600 });
    const target = path.join(root, fixture.relativePath);
    await unlink(target);
    await symlink(victim, target);

    await expect(
      generateProgressiveContentCorpus({
        outDir: root,
        rootSeed: "symlink-seed",
        generatorRevision: "test-revision",
      }),
    ).rejects.toMatchObject({
      code: "PROGRESSIVE_CONTENT_SYMLINK_REJECTED",
    });
    expect(await readFile(victim, "utf8")).toBe("DO NOT CHANGE");
  });

  it("removes stale owned artifacts when a generation seed changes", async () => {
    const root = await makeRoot();
    const first = await generateProgressiveContentCorpus({
      outDir: root,
      rootSeed: "stale-seed-a",
      generatorRevision: "test-revision",
    });
    const stalePath = path.join(
      root,
      first.formatFixtures[0]?.relativePath ?? "missing",
    );
    const second = await generateProgressiveContentCorpus({
      outDir: root,
      rootSeed: "stale-seed-b",
      generatorRevision: "test-revision",
    });

    await expect(readFile(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await verifyProgressiveContentCorpus(root)).toEqual(second);
  });

  it("never adopts or deletes files without a prior verified manifest", async () => {
    const root = await makeRoot();
    const formats = path.join(root, "formats");
    await mkdir(formats, { mode: 0o700 });
    const unrelated = path.join(formats, "unrelated-user-file.txt");
    await writeFile(unrelated, "PRESERVE ME", { mode: 0o600 });

    await expect(
      generateProgressiveContentCorpus({
        outDir: root,
        rootSeed: "unowned-file-seed",
        generatorRevision: "test-revision",
      }),
    ).rejects.toMatchObject({
      code: "PROGRESSIVE_CONTENT_UNOWNED_FILE_REJECTED",
    });
    expect(await readFile(unrelated, "utf8")).toBe("PRESERVE ME");
  });

  it("rejects signed manifest mutants that remove extraction oracles", async () => {
    const root = await makeRoot();
    await generateProgressiveContentCorpus({
      outDir: root,
      rootSeed: "oracle-mutant-seed",
      generatorRevision: "test-revision",
    });
    const manifestPath = path.join(root, "manifest.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const fixtures = parsed.formatFixtures as Array<Record<string, unknown>>;
    delete fixtures[0]?.expectedTextSha256;
    const mutant = signManifest(parsed);
    await writeFile(manifestPath, `${JSON.stringify(mutant)}\n`, {
      mode: 0o600,
    });

    await expect(verifyProgressiveContentCorpus(root)).rejects.toMatchObject({
      code: "PROGRESSIVE_CONTENT_ORACLE_MISMATCH",
    });
  });

  it("rejects signed manifest mutants that erase canary and decoy coordinates", async () => {
    const root = await makeRoot();
    await generateProgressiveContentCorpus({
      outDir: root,
      rootSeed: "coordinate-mutant-seed",
      generatorRevision: "test-revision",
    });
    const manifestPath = path.join(root, "manifest.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const fixtures = parsed.formatFixtures as Array<Record<string, unknown>>;
    if (!fixtures[0]) throw new Error("expected a format fixture");
    fixtures[0].canaries = [];
    fixtures[0].decoys = [];
    const mutant = signManifest(parsed);
    await writeFile(manifestPath, `${JSON.stringify(mutant)}\n`, {
      mode: 0o600,
    });

    await expect(verifyProgressiveContentCorpus(root)).rejects.toMatchObject({
      code: "PROGRESSIVE_CONTENT_ORACLE_MISMATCH",
    });
  });

  it("rejects source tampering even when source and manifest digests are resigned", async () => {
    const root = await makeRoot();
    await generateProgressiveContentCorpus({
      outDir: root,
      rootSeed: "source-mutant-seed",
      generatorRevision: "test-revision",
    });
    const manifestPath = path.join(root, "manifest.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const fixtures = parsed.formatFixtures as Array<Record<string, unknown>>;
    const fixture = fixtures[0];
    if (!fixture || typeof fixture.relativePath !== "string") {
      throw new Error("expected a format fixture");
    }
    const fixturePath = path.join(root, fixture.relativePath);
    const changed = Buffer.from(
      (await readFile(fixturePath, "utf8")).replace("Early", "Other"),
    );
    await writeFile(fixturePath, changed, { mode: 0o600 });
    const digest = createHash("sha256").update(changed).digest("hex");
    fixture.sourceSha256 = digest;
    fixture.revision = digest;
    fixture.byteLength = changed.byteLength;
    const extraction = extractProgressiveFormatFixture("markdown", changed);
    if (extraction.normalizedText === undefined) {
      throw new Error("expected changed Markdown to remain extractable");
    }
    fixture.expectedTextSha256 = createHash("sha256")
      .update(extraction.normalizedText)
      .digest("hex");
    fixture.expectedTextUtf8Bytes = Buffer.byteLength(
      extraction.normalizedText,
    );
    const mutant = signManifest(parsed);
    await writeFile(manifestPath, `${JSON.stringify(mutant)}\n`, {
      mode: 0o600,
    });

    await expect(verifyProgressiveContentCorpus(root)).rejects.toMatchObject({
      code: "PROGRESSIVE_CONTENT_ORACLE_MISMATCH",
    });
  });

  it("rejects fully resigned streamed-object bytes outside every canary", async () => {
    const root = await makeRoot();
    await generateProgressiveContentCorpus({
      outDir: root,
      rootSeed: "object-mutant-seed",
      generatorRevision: "test-revision",
    });
    const manifestPath = path.join(root, "manifest.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const objects = parsed.objects as Array<Record<string, unknown>>;
    const object = objects.find(
      (candidate) =>
        typeof candidate.byteLength === "number" && candidate.byteLength > 500,
    );
    if (!object || typeof object.relativePath !== "string") {
      throw new Error("expected a streamed object fixture");
    }
    const objectPath = path.join(root, object.relativePath);
    const changed = Buffer.from(await readFile(objectPath));
    changed[100] = changed[100] === 0x78 ? 0x79 : 0x78;
    await writeFile(objectPath, changed, { mode: 0o600 });
    const digest = createHash("sha256").update(changed).digest("hex");
    object.sourceSha256 = digest;
    object.revision = digest;
    const mutant = signManifest(parsed);
    await writeFile(manifestPath, `${JSON.stringify(mutant)}\n`, {
      mode: 0o600,
    });

    await expect(verifyProgressiveContentCorpus(root)).rejects.toMatchObject({
      code: "PROGRESSIVE_CONTENT_ORACLE_MISMATCH",
    });
  });
});
