/**
 * End-to-end CLI tests: `runCli` driven against a real tmp git repository
 * with real fixture silos — create a bundle, verify it, tamper with it, and
 * confirm usage errors exit non-zero. Output is captured through the injected
 * writer instead of spawning a child process; everything else is real.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBundle } from "./bundle.ts";
import { runCli } from "./cli.ts";
import { parseManifest, parseMeta } from "./schema.ts";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-cli-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function capture(): {
  io: { out(l: string): void; err(l: string): void };
  outLines: string[];
  errLines: string[];
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    io: {
      out: (l: string) => outLines.push(l),
      err: (l: string) => errLines.push(l),
    },
    outLines,
    errLines,
  };
}

function initFixtureRepo(): string {
  const repo = tmpDir();
  execFileSync("git", ["init", "--initial-branch", "feat/cli-test"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.email", "evidence-test@example.com"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "Evidence Test"], { cwd: repo });
  const auditDir = path.join(
    repo,
    "packages",
    "app",
    "aesthetic-audit-output",
    "desktop",
  );
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(path.join(auditDir, "home.png"), "png-bytes");
  fs.writeFileSync(path.join(auditDir, "home--hover.png"), "png-hover-bytes");
  const scenarioDir = path.join(repo, "reports", "scenarios", "live");
  fs.mkdirSync(scenarioDir, { recursive: true });
  fs.writeFileSync(path.join(scenarioDir, "native.jsonl"), "{}\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial", "--no-gpg-sign"], {
    cwd: repo,
  });
  return repo;
}

function bundleDirFrom(outLines: string[]): string {
  const manifestLine = outLines.find((line) => line.includes("manifest:"));
  expect(manifestLine).toBeDefined();
  return path.dirname((manifestLine as string).split("manifest:")[1].trim());
}

describe("runCli create", () => {
  it("creates a verified bundle from real silos and reports honest statuses", async () => {
    const repo = initFixtureRepo();
    const out = tmpDir();
    const { io, outLines } = capture();
    const code = await runCli(
      ["create", "--tier", "cpu", "--out", out, "--repo-root", repo],
      io,
    );
    expect(code).toBe(0);

    const rendered = outLines.join("\n");
    expect(rendered).toContain("aesthetic-audit");
    expect(rendered).toMatch(/aesthetic-audit\s+ingested\s+2/);
    expect(rendered).toMatch(/scenario-runner\s+ingested\s+1/);
    expect(rendered).toMatch(/e2e-recordings\s+absent\s+-/);
    expect(rendered).toContain("artifacts: 3");

    const dir = bundleDirFrom(outLines);
    const manifest = parseManifest(
      JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")),
      "cli test",
    );
    expect(manifest.artifacts.map((entry) => entry.path)).toEqual([
      "trajectories/scenario-runner/repo/live/native.jsonl",
      "visual/aesthetic-audit/desktop/home--hover.png",
      "visual/aesthetic-audit/desktop/home.png",
    ]);

    const meta = parseMeta(
      JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")),
      "cli test",
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(meta.commit).toBe(head);
    expect(meta.branch).toBe("feat/cli-test");
    expect(meta.tier).toBe("cpu");
    expect(meta.runId).toBe(manifest.runId);
    expect(dir.endsWith(manifest.runId)).toBe(true);
    expect(meta.timings?.["ingest.all"]).toBeTypeOf("number");

    const report = await verifyBundle(dir);
    expect(report.ok).toBe(true);
    expect(report.verifiedCount).toBe(3);
  });

  it("fails loud outside a git repository", async () => {
    const notRepo = tmpDir();
    const { io, errLines } = capture();
    const code = await runCli(
      ["create", "--tier", "cpu", "--out", tmpDir(), "--repo-root", notRepo],
      io,
    );
    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("GIT_PROVENANCE_UNAVAILABLE");
  });

  it.each([
    ["missing tier", ["create"]],
    ["bad tier", ["create", "--tier", "quantum"]],
    ["unknown flag", ["create", "--tier", "cpu", "--wat"]],
    ["unknown command", ["bogus"]],
  ])("exits non-zero on %s", async (_label, argv) => {
    const { io } = capture();
    expect(await runCli(argv, io)).toBe(1);
  });

  it("prints usage and exits zero with no command or --help", async () => {
    const bare = capture();
    expect(await runCli([], bare.io)).toBe(0);
    expect(bare.errLines.join("\n")).toContain("Usage:");
    const help = capture();
    expect(await runCli(["--help"], help.io)).toBe(0);
  });
});

describe("runCli verify", () => {
  it("passes a pristine bundle and fails a tampered one", async () => {
    const repo = initFixtureRepo();
    const out = tmpDir();
    const created = capture();
    expect(
      await runCli(
        ["create", "--tier", "cpu", "--out", out, "--repo-root", repo],
        created.io,
      ),
    ).toBe(0);
    const dir = bundleDirFrom(created.outLines);

    const pristine = capture();
    expect(await runCli(["verify", dir], pristine.io)).toBe(0);
    expect(pristine.outLines.join("\n")).toContain("OK");

    fs.writeFileSync(
      path.join(dir, "visual", "aesthetic-audit", "desktop", "home.png"),
      "TAMPERED!!",
    );
    const tampered = capture();
    expect(await runCli(["verify", dir], tampered.io)).toBe(1);
    expect(tampered.outLines.join("\n")).toContain("FAILED");
    expect(tampered.errLines.join("\n")).toContain(
      "visual/aesthetic-audit/desktop/home.png",
    );
  });

  it("requires exactly one bundle directory", async () => {
    const { io } = capture();
    expect(await runCli(["verify"], io)).toBe(1);
    expect(await runCli(["verify", "a", "b"], io)).toBe(1);
  });
});
