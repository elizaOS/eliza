/**
 * Unit tests for the unified evidence reviewer. The fixtures build a temporary
 * evidence tree so scanning behavior, source status, JSON summaries, and the
 * artifact cap are verified without launching a browser or running Playwright.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHtml,
  parseArgs,
  scanEvidenceSources,
} from "./evidence-reviewer.mjs";

const tempRoots = [];

function tempRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evidence-reviewer-"));
  tempRoots.push(dir);
  return dir;
}

function writeFixture(repoRoot, relPath, content = "fixture") {
  const abs = path.join(repoRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function fakeTools(repoRoot) {
  const binDir = path.join(repoRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const tesseract = path.join(binDir, "tesseract");
  const magick = path.join(binDir, "magick");
  const ffprobe = path.join(binDir, "ffprobe");
  writeFileSync(tesseract, "#!/bin/sh\necho Fixture OCR\n");
  writeFileSync(magick, "#!/bin/sh\necho '1 1 srgb(12,34,56)'\n");
  writeFileSync(
    ffprobe,
    '#!/bin/sh\necho \'{"streams":[{"width":320,"height":180,"duration":"2.5"}]}\'\n',
  );
  for (const tool of [tesseract, magick, ffprobe]) chmodSync(tool, 0o755);
  return { tesseract, magick, ffprobe, identify: null };
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("evidence-reviewer", () => {
  it("parses output, custom sources, and artifact cap flags", () => {
    const args = parseArgs([
      "--no-open",
      "--out",
      "tmp/evidence",
      "--source",
      "custom=tmp/proof",
      "--max-artifacts=12",
    ]);

    expect(args.open).toBe(false);
    expect(args.outDir).toMatch(/tmp\/evidence$/);
    expect(args.sources.at(-1)).toEqual({ id: "custom", dir: "tmp/proof" });
    expect(args.maxArtifacts).toBe(12);
    expect(() => parseArgs(["--install"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--no-install"])).toThrow(/Unknown argument/);
  });

  it("indexes artifacts, missing sources, and JSON report summaries", () => {
    const repoRoot = tempRepo();
    writeFixture(repoRoot, "proof/home.png", "not-a-real-png");
    writeFixture(
      repoRoot,
      "proof/mvp-verify/report.json",
      JSON.stringify({
        summary: {
          states: 4,
          expectationFailures: 1,
          overflowStates: 0,
        },
      }),
    );
    writeFixture(repoRoot, "proof/backend.log", "[ClassName] path fired");

    const manifest = scanEvidenceSources({
      repoRoot,
      sources: [
        { id: "proof", dir: "proof" },
        { id: "missing", dir: "missing" },
      ],
      tools: fakeTools(repoRoot),
    });

    expect(manifest.sources).toMatchObject([
      { id: "proof", present: true, count: 3 },
      { id: "missing", present: false, count: 0 },
    ]);
    expect(manifest.totals).toMatchObject({
      all: 3,
      image: 1,
      json: 1,
      log: 1,
    });
    const report = manifest.artifacts.find((artifact) =>
      artifact.path.endsWith("report.json"),
    );
    expect(report.summary).toContain('"expectationFailures": 1');

    const html = buildHtml(manifest, path.join(repoRoot, "evidence"));
    expect(html).toContain("Evidence Review");
    expect(html).toContain("proof/home.png");
    expect(html).toContain("open the artifacts");
  });

  it("marks the manifest truncated when the cap is reached", () => {
    const repoRoot = tempRepo();
    writeFixture(repoRoot, "proof/a.png");
    writeFixture(repoRoot, "proof/b.png");
    writeFixture(repoRoot, "later/c.png");

    const manifest = scanEvidenceSources({
      repoRoot,
      sources: [
        { id: "proof", dir: "proof" },
        { id: "later", dir: "later" },
      ],
      maxArtifacts: 1,
      tools: fakeTools(repoRoot),
    });

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.truncated).toBe(true);
    expect(manifest.sources).toMatchObject([
      { id: "proof", present: true, count: 2 },
      { id: "later", present: true, count: 1 },
    ]);
    expect(buildHtml(manifest, path.join(repoRoot, "evidence"))).toContain(
      "truncated at 1",
    );
  });

  it("builds artifact links relative to the manifest repo root", () => {
    const repoRoot = tempRepo();
    writeFixture(repoRoot, "proof/screen.png");
    const manifest = scanEvidenceSources({
      repoRoot,
      sources: [{ id: "proof", dir: "proof" }],
      tools: fakeTools(repoRoot),
    });

    const html = buildHtml(manifest, path.join(repoRoot, "nested", "review"));

    expect(html).toContain("../../proof/screen.png");
  });

  it("escapes artifact text inside the embedded script data", () => {
    const repoRoot = tempRepo();
    writeFixture(repoRoot, "proof/run.log", "</script><img src=x>");
    const manifest = scanEvidenceSources({
      repoRoot,
      sources: [{ id: "proof", dir: "proof" }],
      tools: fakeTools(repoRoot),
    });

    const html = buildHtml(manifest, path.join(repoRoot, "evidence"));

    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script><img");
  });
});
