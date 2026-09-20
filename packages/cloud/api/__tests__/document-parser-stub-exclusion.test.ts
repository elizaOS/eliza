/** Verifies Worker parser aliases, fail-closed shim calls, and present bundle artifacts. */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import * as mammothStub from "../src/stubs/mammoth";
import * as unpdfStub from "../src/stubs/unpdf";

const apiRoot = resolve(import.meta.dir, "..");
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

  test.each([
    ["unpdf.definePDFJSModule", unpdfStub.definePDFJSModule],
    ["unpdf.extractImages", unpdfStub.extractImages],
    ["unpdf.extractText", unpdfStub.extractText],
    ["unpdf.getDocumentProxy", unpdfStub.getDocumentProxy],
    ["unpdf.getMeta", unpdfStub.getMeta],
    ["unpdf.getResolvedPDFJS", unpdfStub.getResolvedPDFJS],
    ["unpdf.renderPageAsImage", unpdfStub.renderPageAsImage],
    ["mammoth.convertToHtml", mammothStub.convertToHtml],
    ["mammoth.convertToMarkdown", mammothStub.convertToMarkdown],
    ["mammoth.embedStyleMap", mammothStub.embedStyleMap],
    ["mammoth.extractRawText", mammothStub.extractRawText],
    ["mammoth.images", () => Reflect.get(mammothStub.images, "img")],
  ] as const)("%s rejects unsupported Worker parsing", (_name, call) => {
    expect(call).toThrow(/not available on Cloudflare Workers/i);
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
