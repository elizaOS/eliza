/**
 * Contract tests for quick-app evidence recovery (#20794 live residual):
 * candidate mining is claims-only, fs verification is real stat inspection
 * (traversal-guarded, mtime-gated), route URL mapping follows the operator
 * config with the index.html directory form, and probing verifies only what
 * actually answers 200. Deterministic — fs and fetch are injected doubles,
 * with one real-filesystem case in a temp dir.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectFsObservedFiles,
  deriveRouteMappedUrls,
  detectCheckSurfaces,
  mineCandidatePaths,
  probeMappedUrls,
  readFsVerifiedContents,
} from "../services/quick-app-evidence.js";

describe("mineCandidatePaths", () => {
  it("mines the live incident shape and ignores non-path prose", () => {
    const mined = mineCandidatePaths([
      "Wrote 10092 bytes to /home/milady/projects/agent-home/data/apps/echo-fade/index.html",
      "then I considered v1.2 and e.g. other options",
      "also touched data/apps/echo-fade/style.css today",
    ]);
    expect(mined).toContain(
      "/home/milady/projects/agent-home/data/apps/echo-fade/index.html",
    );
    expect(mined).toContain("data/apps/echo-fade/style.css");
    expect(mined.join(" ")).not.toContain("v1.2");
  });
});

describe("collectFsObservedFiles", () => {
  it("verifies real files in a temp workdir and rejects traversal + stale mtimes", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-evidence-"));
    try {
      const appDir = path.join(workdir, "data", "apps", "echo-fade");
      fs.mkdirSync(appDir, { recursive: true });
      const file = path.join(appDir, "index.html");
      fs.writeFileSync(file, "<html></html>");
      const stale = path.join(workdir, "stale.html");
      fs.writeFileSync(stale, "old");
      const past = new Date(Date.now() - 3_600_000);
      fs.utimesSync(stale, past, past);

      const observed = collectFsObservedFiles({
        workdir,
        candidatePaths: [
          file, // absolute form
          "data/apps/echo-fade/index.html", // relative form (deduped)
          "stale.html", // pre-session mtime → rejected
          "../outside.html", // traversal → rejected
          "data/apps/echo-fade/missing.html", // absent → rejected
        ],
        sessionStartedAt: Date.now() - 60_000,
      });
      expect(observed).toEqual(["data/apps/echo-fade/index.html"]);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("deriveRouteMappedUrls", () => {
  it("maps files through the operator config, with the index directory form", () => {
    const urls = deriveRouteMappedUrls(
      ["data/apps/echo-fade/index.html"],
      [{ urlPrefix: "https://nubilio.org/apps", localPath: "data/apps" }],
    );
    expect(urls).toContain("https://nubilio.org/apps/echo-fade/index.html");
    expect(urls).toContain("https://nubilio.org/apps/echo-fade/");
  });

  it("files outside the mapping and absent mappings yield nothing", () => {
    expect(
      deriveRouteMappedUrls(
        ["src/other.ts"],
        [{ urlPrefix: "https://nubilio.org/apps", localPath: "data/apps" }],
      ),
    ).toEqual([]);
    expect(
      deriveRouteMappedUrls(["data/apps/x/index.html"], undefined),
    ).toEqual([]);
  });
});

describe("probeMappedUrls", () => {
  it("verifies only URLs that answer ok; failures and non-200s drop out", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.endsWith("/good/")) return new Response("ok", { status: 200 });
      if (target.endsWith("/gone/")) return new Response("no", { status: 404 });
      throw new Error("network unreachable");
    }) as typeof fetch;
    const verified = await probeMappedUrls(
      [
        "https://a.example/good/",
        "https://a.example/gone/",
        "https://a.example/down/",
      ],
      fetchImpl,
    );
    expect(verified).toEqual(["https://a.example/good/"]);
  });
});

describe("detectCheckSurfaces (dawn-mesa boundary)", () => {
  it("a vanilla script.js app dir with no tooling has no check surfaces (real fs)", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-"));
    try {
      const appDir = path.join(workdir, "data", "apps", "dawn-mesa");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(path.join(appDir, "index.html"), "<html></html>");
      fs.writeFileSync(path.join(appDir, "script.js"), "console.log(1)");
      // Root tooling exists (the static SERVER's) — must NOT count for the app.
      fs.writeFileSync(path.join(workdir, "package.json"), "{}");
      fs.writeFileSync(path.join(workdir, "tsconfig.json"), "{}");

      const surfaces = detectCheckSurfaces(workdir, [
        "data/apps/dawn-mesa/index.html",
        "data/apps/dawn-mesa/script.js",
      ]);
      expect(surfaces).toEqual({ typecheck: false, lint: false, test: false });
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("a deliverable AT a tooling boundary detects runnable checks (real fs)", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-"));
    try {
      fs.writeFileSync(path.join(workdir, "package.json"), "{}");
      fs.writeFileSync(path.join(workdir, "tsconfig.json"), "{}");
      fs.writeFileSync(path.join(workdir, "biome.json"), "{}");
      fs.writeFileSync(path.join(workdir, "calc.js"), "console.log(1)");

      const surfaces = detectCheckSurfaces(workdir, ["calc.js"]);
      expect(surfaces).toEqual({ typecheck: true, lint: true, test: true });
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("a test file among the deliverable implies a test surface", () => {
    const surfaces = detectCheckSurfaces(
      "/nonexistent-root",
      ["pkg/thing.test.ts"],
      () => false,
    );
    expect(surfaces.test).toBe(true);
    expect(surfaces.typecheck).toBe(false);
  });
});

describe("readFsVerifiedContents (reed-marsh content criteria)", () => {
  it("reads real file text with caps, skipping binaries and traversal", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "content-"));
    try {
      const appDir = path.join(workdir, "data", "apps", "reed-marsh");
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "style.css"),
        "body { background: linear-gradient(#3aa8a0, #0f2f2c); }",
      );
      fs.writeFileSync(path.join(appDir, "big.css"), "x".repeat(9000));
      fs.writeFileSync(path.join(appDir, "img.png"), "notreally");

      const contents = readFsVerifiedContents(workdir, [
        "data/apps/reed-marsh/style.css",
        "data/apps/reed-marsh/big.css",
        "data/apps/reed-marsh/img.png",
        "../outside.css",
      ]);
      expect(contents.map((c) => c.path)).toEqual([
        "data/apps/reed-marsh/style.css",
        "data/apps/reed-marsh/big.css",
      ]);
      expect(contents[0]?.content).toContain("linear-gradient(#3aa8a0");
      expect(contents[1]?.content).toContain("[truncated]");
      // MAX_CONTENT_CHARS is 6_000 (raised so whole small apps fit the verifier).
      expect(contents[1]?.content.length).toBeLessThan(6200);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("unreadable files are absent, never fabricated", () => {
    const contents = readFsVerifiedContents(
      "/nonexistent-root",
      ["a.css"],
      () => undefined,
    );
    expect(contents).toEqual([]);
  });
});
