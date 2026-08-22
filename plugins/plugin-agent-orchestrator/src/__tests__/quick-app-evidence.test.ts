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
import { readDurableContent } from "../services/durable-content-store.js";
import {
  collectFsObservedFiles,
  deriveRouteMappedUrls,
  detectCheckSurfaces,
  enumerateWorkdirCandidates,
  enumerateWorkdirCandidatesDetailed,
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

describe("enumerateWorkdirCandidates (exhaustive walk, named exclusions)", () => {
  it("nominates deep and dot-path deliverables; skips plumbing and vendor dirs", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "enumerate-"));
    try {
      // 5 directories deep — the old depth-3 cap silently dropped this.
      const deep = path.join(workdir, "a", "b", "c", "d", "e");
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, "deep.html"), "<html></html>");
      // Dot-path deliverable — the old blanket dot-skip silently dropped it.
      const workflows = path.join(workdir, ".github", "workflows");
      fs.mkdirSync(workflows, { recursive: true });
      fs.writeFileSync(path.join(workflows, "ci.yml"), "on: push\n");
      // Named exclusions stay excluded.
      fs.writeFileSync(path.join(workdir, "AGENTS.md"), "plumbing");
      fs.mkdirSync(path.join(workdir, "node_modules"));
      fs.writeFileSync(path.join(workdir, "node_modules", "x.js"), "noise");
      fs.mkdirSync(path.join(workdir, ".git"));
      fs.writeFileSync(path.join(workdir, ".git", "config"), "[core]");

      const files = enumerateWorkdirCandidates(workdir);
      expect(files).toContain(path.join("a", "b", "c", "d", "e", "deep.html"));
      expect(files).toContain(path.join(".github", "workflows", "ci.yml"));
      expect(files).not.toContain("AGENTS.md");
      expect(files.some((f) => f.startsWith("node_modules"))).toBe(false);
      expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("a tripped sanity ceiling records the explicit continuation note (nothing silent)", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "enumerate-cap-"));
    try {
      for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
        fs.writeFileSync(path.join(workdir, name), name);
      }
      fs.mkdirSync(path.join(workdir, "sub"));
      fs.writeFileSync(path.join(workdir, "sub", "e.txt"), "e");

      const capped = enumerateWorkdirCandidatesDetailed(workdir, {
        maxEntries: 2,
      });
      expect(capped.truncated).toBe(true);
      expect(capped.candidates).toHaveLength(2);
      // Every file is accounted for: nominated OR named as not traversed.
      expect(
        capped.candidates.length + capped.notTraversed.length,
      ).toBeGreaterThanOrEqual(5);
      // Deterministic cut: sorted visit order decides which entries survive.
      expect(capped.candidates).toEqual(["a.txt", "b.txt"]);

      const shallow = enumerateWorkdirCandidatesDetailed(workdir, {
        maxDepth: 0,
      });
      expect(shallow.truncated).toBe(true);
      expect(shallow.notTraversed).toContain("sub/");

      const exhaustive = enumerateWorkdirCandidatesDetailed(workdir);
      expect(exhaustive.truncated).toBe(false);
      expect(exhaustive.notTraversed).toEqual([]);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("readFsVerifiedContents (reed-marsh content criteria)", () => {
  it("reads complete real file text, skipping binaries and traversal", () => {
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
      expect(contents[1]?.content).toBe("x".repeat(9000));
      // A typical 6-8KB quick-app file must survive whole (velvet-moth park).
      const typical = path.join(appDir, "typical.js");
      fs.writeFileSync(typical, "y".repeat(7000));
      const [whole] = readFsVerifiedContents(workdir, [
        "data/apps/reed-marsh/typical.js",
      ]);
      expect(whole?.content).toHaveLength(7000);
      expect(whole?.content).not.toContain("[truncated]");
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

  it("inlines source/config text (sniffed, not extension-allowlisted) and skips real binaries", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "content-sniff-"));
    try {
      fs.writeFileSync(path.join(workdir, "app.py"), "print('hello')\n");
      fs.writeFileSync(path.join(workdir, "config.yml"), "port: 8080\n");
      fs.writeFileSync(path.join(workdir, "Makefile"), "all:\n\techo ok\n");
      // Text-extension-free blob with a NUL byte — the sniff, not the name,
      // classifies it as binary.
      fs.writeFileSync(
        path.join(workdir, "blob.dat"),
        Buffer.from([0x41, 0x00, 0x42]),
      );

      const contents = readFsVerifiedContents(workdir, [
        "app.py",
        "config.yml",
        "Makefile",
        "blob.dat",
      ]);
      expect(contents.map((c) => c.path)).toEqual([
        "app.py",
        "config.yml",
        "Makefile",
      ]);
      expect(contents[0]?.content).toBe("print('hello')\n");
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("an oversized text file is paged with a durable continuation reference, never cut silently", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "content-big-"));
    const trajectoryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "content-traj-"),
    );
    const savedEnv = process.env.ELIZA_TRAJECTORY_DIR;
    process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
    try {
      const text = `console.log(1);\n${"z".repeat(30_000)}`;
      fs.writeFileSync(path.join(workdir, "big.js"), text);
      const [entry] = readFsVerifiedContents(workdir, ["big.js"]);
      expect(entry?.content.length).toBeLessThanOrEqual(24_000);
      const sha = /\/api\/orchestrator\/content\/([0-9a-f]{64})/.exec(
        entry?.content ?? "",
      )?.[1];
      expect(sha).toBeTruthy();
      // The reference resolves to the COMPLETE file text.
      const window = readDurableContent(sha ?? "", { limit: 1_048_576 });
      expect(window?.text).toBe(text);
    } finally {
      if (savedEnv === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
      else process.env.ELIZA_TRAJECTORY_DIR = savedEnv;
      fs.rmSync(workdir, { recursive: true, force: true });
      fs.rmSync(trajectoryDir, { recursive: true, force: true });
    }
  });
});
