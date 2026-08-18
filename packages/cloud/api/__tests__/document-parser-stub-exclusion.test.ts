/**
 * Guards the Worker bundle against re-inlining core's document parsers
 * (#21327). Wrangler resolves `@elizaos/core/edge` to core SOURCE (this
 * package's tsconfig paths), so core's `await import("unpdf" | "mammoth")`
 * calls are inlined into the deployed artifact — ~70 pdfjs modules plus the
 * jszip/pako/bluebird docx graph, ~2.2 MB minified — even though document
 * extraction runs on the Node sidecar and `documents` is `false` in core's
 * `nativeRuntimeFeatureDefaults`. Three invariants keep that exclusion honest:
 *   1. wrangler.toml aliases both packages to Worker stubs,
 *   2. the stubs export every symbol core's parser call sites dereference,
 *   3. those stubs fail closed (throw) rather than returning empty text,
 * and, when a dry-run artifact is present, that no parser code survived it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import * as mammothStub from "../src/stubs/mammoth";
import * as unpdfStub from "../src/stubs/unpdf";

const apiRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(apiRoot, "../../..");
const wranglerConfig = readFileSync(join(apiRoot, "wrangler.toml"), "utf8");

describe("Worker bundle excludes core's document parsers", () => {
  test("wrangler aliases both parser packages to Worker stubs", () => {
    expect(wranglerConfig).toMatch(
      /^"unpdf"\s*=\s*"\.\/src\/stubs\/unpdf\.ts"$/m,
    );
    expect(wranglerConfig).toMatch(
      /^"mammoth"\s*=\s*"\.\/src\/stubs\/mammoth\.ts"$/m,
    );
  });

  test("stubs export the symbols core's parser call sites destructure", () => {
    // core/src/features/documents/parsers.ts binds these two names; a stub that
    // omits one fails the bundle at link time with "Export named 'X' not found".
    const parserSource = readFileSync(
      join(repoRoot, "packages/core/src/features/documents/parsers.ts"),
      "utf8",
    );
    expect(parserSource).toContain('await import("unpdf")');
    expect(parserSource).toContain('await import("mammoth")');

    expect(typeof unpdfStub.extractText).toBe("function");
    expect(typeof mammothStub.extractRawText).toBe("function");
  });

  test("stubbed parsers fail closed instead of returning empty text", () => {
    expect(() => unpdfStub.extractText()).toThrow(
      /not available on Cloudflare Workers/i,
    );
    expect(() => mammothStub.extractRawText()).toThrow(
      /not available on Cloudflare Workers/i,
    );
  });

  test("a produced dry-run bundle carries no PDF/DOCX parser code", () => {
    // Populated by `bun run --cwd packages/cloud/api check:worker-bundle`.
    // Skipped when absent so the unit lane stays fast; CI's bundle check and
    // the reviewer-facing dry run both exercise it.
    const bundle = join(apiRoot, ".wrangler-dry-run/index.js");
    if (!existsSync(bundle)) return;
    const emitted = readFileSync(bundle, "utf8");

    expect(emitted).not.toMatch(/pdfjs/);
    expect(emitted).not.toMatch(/dingbat-to-unicode/);
    expect(emitted).toContain("not available on Cloudflare Workers");
  });
});
