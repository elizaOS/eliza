/**
 * Silo-ingestor tests against fixture trees replicating each silo's real
 * on-disk shape (e2e-recordings run dirs, aesthetic-audit output, device-e2e
 * bundle dirs from packages/app/scripts/lib/device-e2e-bundle.mjs, Playwright
 * test-results, walkthrough/live-run reports, scenario-runner reports). Also
 * pins the honesty contract: an absent silo reports `absent`, an existing but
 * empty silo reports `ingested` with zero artifacts — never the same result.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundle, type EvidenceBundle } from "./bundle.ts";
import { EvidenceError } from "./errors.ts";
import { ingestAllSilos, ingestNamedSilo, SILO_NAMES } from "./ingest.ts";
import type { ArtifactEntry } from "./schema.ts";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-ingest-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function write(repoRoot: string, relPath: string, content: string): void {
  const filePath = path.join(repoRoot, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** Fixture repo mirroring the real silo layouts inspected on develop. */
function buildFixtureRepo(): string {
  const repo = tmpDir();
  // scripts/e2e-recordings/run-all.mjs output: per-package Playwright results.
  write(
    repo,
    "e2e-recordings/app-ui/test-results/chat-flow/video.webm",
    "webm",
  );
  write(repo, "e2e-recordings/app-ui/test-results/chat-flow/final.png", "png");
  write(repo, "e2e-recordings/contact-sheet.html", "<html></html>");
  // packages/app audit:app output.
  write(repo, "packages/app/aesthetic-audit-output/desktop/chat.png", "png-d");
  write(
    repo,
    "packages/app/aesthetic-audit-output/desktop/chat--hover.png",
    "png-h",
  );
  write(repo, "packages/app/aesthetic-audit-output/mobile/chat.png", "png-m");
  write(
    repo,
    "packages/app/aesthetic-audit-output/manual-review/chat.md",
    "verdict: good",
  );
  write(repo, "packages/app/aesthetic-audit-output/report.json", "{}");
  // device-e2e bundle dir shape (summary.json + junit.xml + inline/).
  const deviceRun =
    "packages/app/device-e2e-output/android-2026-07-05T01-02-03-004Z";
  write(repo, `${deviceRun}/summary.json`, "{}");
  write(repo, `${deviceRun}/junit.xml`, "<testsuite/>");
  write(repo, `${deviceRun}/inline/screen.jpg`, "jpg");
  write(repo, `${deviceRun}/inline/walkthrough.mp4`, "mp4");
  // Playwright test-results.
  write(
    repo,
    "packages/app/test-results/chat-smoke/test-failed-1.png",
    "png-f",
  );
  write(repo, "packages/app/test-results/.last-run.json", "{}");
  // Walkthrough reports exist under BOTH roots — exercises namespacing.
  write(repo, "reports/walkthrough/desktop.mp4", "mp4-repo");
  write(repo, "packages/app/reports/walkthrough/mobile.mp4", "mp4-app");
  // Live test runs.
  write(repo, "reports/live-test-runs/run-1/server.log", "log");
  // scenario-runner reports + repo-level scenario reports.
  write(repo, "packages/scenario-runner/reports/report.json", "{}");
  write(repo, "reports/scenarios/live/native.jsonl", "{}\n");
  // Noise that must never be ingested.
  write(repo, "e2e-recordings/node_modules/pkg/index.js", "js");
  return repo;
}

async function build(repo: string): Promise<{
  bundle: EvidenceBundle;
  results: Awaited<ReturnType<typeof ingestAllSilos>>;
  artifacts: ArtifactEntry[];
}> {
  const bundle = createBundle({
    rootDir: tmpDir(),
    provenance: {
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      branch: "feat/test",
      runner: "local",
      tier: "cpu",
      envFingerprint: {
        node: "v24",
        platform: "linux",
        arch: "x64",
        tier: "cpu",
      },
    },
  });
  const results = await ingestAllSilos(bundle, repo);
  const { manifest } = await bundle.finalize();
  return { bundle, results, artifacts: manifest.artifacts };
}

describe("ingestAllSilos", () => {
  it("ingests every fixture silo with honest per-silo counts", async () => {
    const { results } = await build(buildFixtureRepo());
    expect(Object.fromEntries(results.map((r) => [r.silo, r]))).toEqual({
      "e2e-recordings": {
        silo: "e2e-recordings",
        status: "ingested",
        artifactCount: 3,
      },
      "aesthetic-audit": {
        silo: "aesthetic-audit",
        status: "ingested",
        artifactCount: 5,
      },
      "device-e2e": {
        silo: "device-e2e",
        status: "ingested",
        artifactCount: 4,
      },
      "playwright-test-results": {
        silo: "playwright-test-results",
        status: "ingested",
        artifactCount: 2,
      },
      "walkthrough-reports": {
        silo: "walkthrough-reports",
        status: "ingested",
        artifactCount: 2,
      },
      "live-test-runs": {
        silo: "live-test-runs",
        status: "ingested",
        artifactCount: 1,
      },
      "scenario-runner": {
        silo: "scenario-runner",
        status: "ingested",
        artifactCount: 2,
      },
    });
  });

  it("classifies kinds, lanes, and sources per silo", async () => {
    const { artifacts } = await build(buildFixtureRepo());
    const byPath = Object.fromEntries(
      artifacts.map((entry) => [entry.path, entry]),
    );

    // Manual-review markdown is analysis, not a generated report.
    const review = byPath["misc/aesthetic-audit/manual-review/chat.md"];
    expect(review).toMatchObject({
      kind: "analysis",
      source: "aesthetic-audit",
    });
    expect(review.lane).toBeUndefined();

    expect(
      byPath["visual/aesthetic-audit/desktop/chat--hover.png"],
    ).toMatchObject({
      kind: "screenshot",
    });
    expect(
      byPath["video/e2e-recordings/app-ui/test-results/chat-flow/video.webm"],
    ).toMatchObject({ kind: "video", lane: "e2e" });
    expect(byPath["lanes/e2e/contact-sheet.html"]).toMatchObject({
      kind: "report",
      source: "e2e-recordings",
    });
    expect(
      byPath["trajectories/scenario-runner/repo/live/native.jsonl"],
    ).toMatchObject({ kind: "trajectory", lane: "scenario" });
    expect(byPath["lanes/scenario/runner/report.json"]).toMatchObject({
      kind: "report",
      source: "scenario-runner",
    });
    expect(
      byPath["lanes/native/app/android-2026-07-05T01-02-03-004Z/summary.json"],
    ).toMatchObject({ kind: "report", source: "device-e2e" });
    expect(
      byPath[
        "visual/device-e2e/app/android-2026-07-05T01-02-03-004Z/inline/screen.jpg"
      ],
    ).toMatchObject({ kind: "screenshot", lane: "native" });
    expect(
      byPath["visual/playwright/chat-smoke/test-failed-1.png"],
    ).toMatchObject({
      kind: "screenshot",
      lane: "e2e",
    });

    // Multi-root walkthrough silo namespaces by root label.
    expect(byPath["video/walkthrough/repo/desktop.mp4"]).toBeDefined();
    expect(byPath["video/walkthrough/app/mobile.mp4"]).toBeDefined();

    // node_modules content is never evidence.
    expect(artifacts.some((entry) => entry.path.includes("node_modules"))).toBe(
      false,
    );
  });

  it("copies real bytes into the bundle", async () => {
    const repo = buildFixtureRepo();
    const { bundle, artifacts } = await build(repo);
    const review = artifacts.find(
      (entry) => entry.path === "misc/aesthetic-audit/manual-review/chat.md",
    );
    expect(review).toBeDefined();
    const stored = path.join(
      bundle.dir,
      ...(review as ArtifactEntry).path.split("/"),
    );
    expect(fs.readFileSync(stored, "utf8")).toBe("verdict: good");
  });

  it("distinguishes an absent silo from an empty one", async () => {
    const repo = tmpDir();
    // aesthetic-audit dir exists but is empty; every other silo is absent.
    fs.mkdirSync(path.join(repo, "packages", "app", "aesthetic-audit-output"), {
      recursive: true,
    });
    const { results } = await build(repo);
    const byName = Object.fromEntries(results.map((r) => [r.silo, r]));
    expect(byName["aesthetic-audit"]).toEqual({
      silo: "aesthetic-audit",
      status: "ingested",
      artifactCount: 0,
    });
    expect(byName["e2e-recordings"]).toEqual({
      silo: "e2e-recordings",
      status: "absent",
      artifactCount: 0,
    });
    for (const name of SILO_NAMES) {
      if (name === "aesthetic-audit") continue;
      expect(byName[name].status).toBe("absent");
    }
  });
});

describe("ingestNamedSilo", () => {
  it("runs a single silo by name", async () => {
    const repo = buildFixtureRepo();
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: {
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "feat/test",
        runner: "local",
        tier: "cpu",
        envFingerprint: {
          node: "v24",
          platform: "linux",
          arch: "x64",
          tier: "cpu",
        },
      },
    });
    const result = await ingestNamedSilo(bundle, repo, "live-test-runs");
    expect(result).toEqual({
      silo: "live-test-runs",
      status: "ingested",
      artifactCount: 1,
    });
  });

  it("throws a typed error for an unknown silo name", async () => {
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: {
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "feat/test",
        runner: "local",
        tier: "cpu",
        envFingerprint: {
          node: "v24",
          platform: "linux",
          arch: "x64",
          tier: "cpu",
        },
      },
    });
    await expect(
      ingestNamedSilo(bundle, tmpDir(), "nope"),
    ).rejects.toMatchObject({
      code: "SILO_UNKNOWN",
    });
    await expect(
      ingestNamedSilo(bundle, tmpDir(), "nope"),
    ).rejects.toBeInstanceOf(EvidenceError);
  });
});
