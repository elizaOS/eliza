/**
 * Guardrail for docs/E2E_LIVE_COVERAGE.md (#14420): every repo path the doc
 * references must exist, and the removed whisper.cpp voice path must never
 * creep back in.
 *
 * The doc previously kept documenting a deleted STT test
 * (whisper-cpp-asr.real.test.ts) and a deleted build script
 * (build-whisper.mjs) long after the runtime moved to the fused
 * eliza-1-asr path. This boot-free vitest gate (file reads + existsSync,
 * same style as chat-gesture-coverage.test.ts) makes that class of doc rot
 * a CI failure instead of a scavenger hunt.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const DOC_PATH = path.join(REPO_ROOT, "packages/app/docs/E2E_LIVE_COVERAGE.md");

/**
 * Backtick-quoted repo-rooted paths (packages/, plugins/, .github/). Paths
 * under build/dist output dirs are runtime artifacts, not tracked sources, so
 * they are excluded from the existence check.
 */
function referencedRepoPaths(doc: string): string[] {
  const out = new Set<string>();
  const re = /`((?:packages|plugins|\.github)\/[A-Za-z0-9_./-]+)`/g;
  for (const match of doc.matchAll(re)) {
    const p = match[1].replace(/\/$/, "");
    if (/(^|\/)(build|dist|node_modules)(\/|$)/.test(p)) continue;
    out.add(p);
  }
  return [...out].sort();
}

describe("E2E_LIVE_COVERAGE.md path integrity", () => {
  const doc = readFileSync(DOC_PATH, "utf8");

  it("references only paths that exist in the repo", () => {
    const paths = referencedRepoPaths(doc);
    // Sanity: a broken extraction regex must not silently empty the roster.
    expect(paths.length).toBeGreaterThan(10);
    const missing = paths.filter((p) => !existsSync(path.join(REPO_ROOT, p)));
    expect(
      missing,
      `E2E_LIVE_COVERAGE.md references missing paths:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("does not reference the removed whisper.cpp voice path (#14420)", () => {
    for (const banned of [
      "whisper-cpp-asr.real.test.ts",
      "build-whisper.mjs",
      "ggml-base.en.bin",
      "ELIZA_WHISPER_MODEL",
      "build-omnivoice.mjs",
    ]) {
      expect(
        doc,
        `stale reference to removed voice path: ${banned}`,
      ).not.toContain(banned);
    }
  });
});
