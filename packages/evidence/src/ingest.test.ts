/**
 * Silo-ingestor tests against fixture trees replicating each silo's real
 * on-disk shape (e2e-recordings run dirs, aesthetic-audit output, device-e2e
 * bundle dirs from packages/app/scripts/lib/device-e2e-bundle.mjs, Playwright
 * test-results, iOS boot captures/device logs, walkthrough/live-run reports,
 * scenario-runner reports, and provider-qualification artifacts). Also
 * pins the honesty contract: an absent silo reports `absent`, an existing but
 * empty silo reports `ingested` with zero artifacts — never the same result.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundle, type EvidenceBundle } from "./bundle.ts";
import { EvidenceError } from "./errors.ts";
import {
  assertSafeBundleOutput,
  captureSiloSnapshot,
  ingestAllSilos,
  ingestNamedSilo,
  SILO_NAMES,
} from "./ingest.ts";
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
  // iOS device/simulator capture lanes.
  write(
    repo,
    "packages/app/ios/build/boot-capture/run-1/shards/chat/screen.png",
    "ios-png",
  );
  write(
    repo,
    "packages/app/ios/build/boot-capture/run-1/test-summary.json",
    "{}",
  );
  write(repo, "packages/app/ios/build/device-logs/device.log", "ios-log");
  // Canonical walkthrough output is repo-root reports/walkthrough.
  write(repo, "reports/walkthrough/desktop.mp4", "mp4-repo");
  // Live test runs.
  write(repo, "reports/live-test-runs/run-1/server.log", "log");
  // Canonical scenario-runner package commands write repo-level reports.
  write(repo, "reports/scenarios/live/native.jsonl", "{}\n");
  // The coordinated producer publishes only hash-bound summaries after every
  // private verifier artifact passes the exact-inventory catalog.
  write(
    repo,
    "reports/provider-qualification/run-1/gmail/qualification.md",
    "# Provider qualification\n",
  );
  write(
    repo,
    "reports/provider-qualification/run-1/catalog/catalog.md",
    "# Provider qualification catalog\n",
  );
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
  it("includes a byte-identical file rewritten during the run", async () => {
    const repo = tmpDir();
    const file = path.join(repo, "packages/app/test-results/reused.log");
    write(repo, "packages/app/test-results/reused.log", "same");
    const baseline = captureSiloSnapshot(repo);
    fs.writeFileSync(file, "same");
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: {
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "fix/rewrite",
        runner: "local",
        tier: "cpu",
        envFingerprint: { node: "v24" },
      },
    });
    await ingestAllSilos(bundle, repo, baseline);
    expect((await bundle.finalize()).manifest.artifacts).toHaveLength(1);
  });

  it("copies the same stable bytes that won the baseline comparison", async () => {
    const repo = tmpDir();
    const file = path.join(repo, "packages/app/test-results/race.log");
    write(repo, "packages/app/test-results/race.log", "OLD");
    const baseline = captureSiloSnapshot(repo);
    const originalRead = fs.readSync;
    let changed = false;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      if (!changed && count > 0) {
        changed = true;
        fs.writeFileSync(file, "NEW");
      }
      return count;
    }) as typeof fs.readSync;
    try {
      const bundle = createBundle({
        rootDir: tmpDir(),
        provenance: {
          commit: "abcdef0123456789abcdef0123456789abcdef01",
          branch: "fix/race",
          runner: "local",
          tier: "cpu",
          envFingerprint: { node: "v24" },
        },
      });
      await ingestAllSilos(bundle, repo, baseline);
      const finalized = await bundle.finalize();
      expect(finalized.manifest.artifacts).toHaveLength(1);
      expect(
        fs.readFileSync(
          path.join(bundle.dir, finalized.manifest.artifacts[0].path),
          "utf8",
        ),
      ).toBe("NEW");
    } finally {
      fs.readSync = originalRead;
    }
  });

  it("fails after bounded retries when a producer file never stabilizes", () => {
    const repo = tmpDir();
    const file = path.join(repo, "packages/app/test-results/churning.log");
    write(repo, "packages/app/test-results/churning.log", "AAA");
    const originalRead = fs.readSync;
    let toggle = false;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      if (count > 0) {
        toggle = !toggle;
        fs.writeFileSync(file, toggle ? "BBB" : "AAA");
      }
      return count;
    }) as typeof fs.readSync;
    try {
      expect(() => captureSiloSnapshot(repo)).toThrow(
        expect.objectContaining({ code: "SILO_SOURCE_UNSTABLE" }),
      );
    } finally {
      fs.readSync = originalRead;
    }
  });

  it("rejects symlinked producer roots and bundle-output overlap", () => {
    const repo = tmpDir();
    const external = tmpDir();
    write(external, "outside.log", "outside");
    fs.symlinkSync(external, path.join(repo, "e2e-recordings"), "dir");
    expect(() => captureSiloSnapshot(repo)).toThrow(/canonical evidence root/);
    expect(() =>
      assertSafeBundleOutput(repo, path.join(repo, "e2e-recordings", "runs")),
    ).toThrow();

    fs.rmSync(path.join(repo, "e2e-recordings"), { recursive: true });
    fs.mkdirSync(path.join(repo, "packages/app/test-results"), {
      recursive: true,
    });
    expect(() =>
      assertSafeBundleOutput(
        repo,
        path.join(repo, "packages/app/test-results/bundles"),
      ),
    ).toThrow(/overlaps canonical evidence root/);
    expect(() => assertSafeBundleOutput(repo, repo)).toThrow(
      /overlaps canonical evidence root/,
    );
  });

  it("rejects hardlinked files that can expose bytes outside a silo", () => {
    const repo = tmpDir();
    const external = path.join(tmpDir(), "external-secret.log");
    fs.writeFileSync(external, "not producer evidence");
    const producer = path.join(repo, "packages/app/test-results/leak.log");
    fs.mkdirSync(path.dirname(producer), { recursive: true });
    fs.linkSync(external, producer);

    expect(() => captureSiloSnapshot(repo)).toThrow(
      expect.objectContaining({ code: "SILO_SOURCE_UNSAFE" }),
    );
  });

  it("rejects direct-library self-ingest when the bundle is under a producer", async () => {
    const repo = tmpDir();
    write(repo, "packages/app/test-results/current.log", "current");
    const bundle = createBundle({
      rootDir: path.join(repo, "packages/app/test-results/evidence-runs"),
      provenance: {
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "fix/self-ingest",
        runner: "local",
        tier: "cpu",
        envFingerprint: { node: "v24" },
      },
    });

    await expect(ingestAllSilos(bundle, repo)).rejects.toMatchObject({
      code: "BUNDLE_OUTPUT_UNSAFE",
    });
  });

  it("excludes unchanged stale files and includes only exact-run deltas", async () => {
    const repo = tmpDir();
    write(repo, "packages/app/test-results/stale.log", "old");
    write(repo, "reports/scenarios/stale.jsonl", "old\n");
    const baseline = captureSiloSnapshot(repo);

    write(repo, "packages/app/test-results/current.log", "new");
    write(repo, "reports/scenarios/stale.jsonl", "changed\n");
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: {
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "fix/exact-run",
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
    const results = await ingestAllSilos(bundle, repo, baseline);
    const { manifest } = await bundle.finalize();

    expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      "lanes/e2e/logs/current.log",
      "trajectories/scenario-runner/stale.jsonl",
    ]);
    expect(
      results.find((result) => result.silo === "playwright-test-results"),
    ).toMatchObject({ status: "ingested", artifactCount: 1 });
    expect(
      manifest.artifacts.some((artifact) =>
        artifact.path.includes("stale.log"),
      ),
    ).toBe(false);
  });

  it("contributes zero artifacts when every producer file is unchanged", async () => {
    const repo = buildFixtureRepo();
    const baseline = captureSiloSnapshot(repo);
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: {
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "fix/skipped-lane",
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
    const results = await ingestAllSilos(bundle, repo, baseline);
    const { manifest } = await bundle.finalize();
    expect(manifest.artifacts).toEqual([]);
    expect(results.every((result) => result.artifactCount === 0)).toBe(true);
  });

  it("does not relabel a file deleted during the run as current evidence", async () => {
    const repo = tmpDir();
    const deleted = path.join(repo, "packages/app/test-results/deleted.log");
    write(repo, "packages/app/test-results/deleted.log", "old");
    const baseline = captureSiloSnapshot(repo);
    fs.rmSync(deleted);
    const bundle = createBundle({
      rootDir: tmpDir(),
      provenance: {
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "fix/delete",
        runner: "local",
        tier: "cpu",
        envFingerprint: { node: "v24" },
      },
    });
    const results = await ingestAllSilos(bundle, repo, baseline);
    expect((await bundle.finalize()).manifest.artifacts).toEqual([]);
    expect(
      results.find((result) => result.silo === "playwright-test-results"),
    ).toMatchObject({ status: "ingested", artifactCount: 0 });
  });

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
      "ios-device-capture": {
        silo: "ios-device-capture",
        status: "ingested",
        artifactCount: 3,
      },
      "walkthrough-reports": {
        silo: "walkthrough-reports",
        status: "ingested",
        artifactCount: 1,
      },
      "live-test-runs": {
        silo: "live-test-runs",
        status: "ingested",
        artifactCount: 1,
      },
      "scenario-runner": {
        silo: "scenario-runner",
        status: "ingested",
        artifactCount: 1,
      },
      "provider-qualification": {
        silo: "provider-qualification",
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
      byPath["trajectories/scenario-runner/live/native.jsonl"],
    ).toMatchObject({ kind: "trajectory", lane: "scenario" });
    expect(
      byPath["misc/provider-qualification/run-1/catalog/catalog.md"],
    ).toMatchObject({
      kind: "report",
      source: "provider-qualification",
      producedBy: "scripts/evidence-review/provider-qualification-producer.mjs",
    });
    expect(
      byPath["misc/provider-qualification/run-1/gmail/qualification.md"],
    ).toMatchObject({ kind: "report", source: "provider-qualification" });
    expect(
      byPath["lanes/native/android-2026-07-05T01-02-03-004Z/summary.json"],
    ).toMatchObject({ kind: "report", source: "device-e2e" });
    expect(
      byPath[
        "visual/device-e2e/android-2026-07-05T01-02-03-004Z/inline/screen.jpg"
      ],
    ).toMatchObject({ kind: "screenshot", lane: "native" });
    expect(
      byPath["visual/app-test-results/chat-smoke/test-failed-1.png"],
    ).toMatchObject({
      kind: "screenshot",
      lane: "e2e",
    });
    expect(
      byPath[
        "visual/ios-device-capture/boot-capture/run-1/shards/chat/screen.png"
      ],
    ).toMatchObject({
      kind: "screenshot",
      source: "ios-device-capture",
      lane: "native",
    });
    expect(byPath["lanes/native/logs/device-logs/device.log"]).toMatchObject({
      kind: "log",
      source: "ios-device-capture",
    });

    expect(byPath["video/walkthrough/desktop.mp4"]).toBeDefined();

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
