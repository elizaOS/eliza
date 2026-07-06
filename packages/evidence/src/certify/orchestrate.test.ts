/**
 * End-to-end orchestrator tests against real finalized bundles and real
 * Ed25519 keys on a tmp filesystem — no mocked crypto, no mocked sign/verify.
 * A scripted matrix runner and injected clock keep runs deterministic; every
 * green assertion re-verifies the produced certification.json with the shipped
 * `verifyCertification`, and every red/tamper assertion drives that same
 * verifier to a typed failure. The fresh-bundle path uses a throwaway git repo
 * so provenance collection is exercised for real.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundle } from "../bundle.ts";
import { runCli } from "../cli.ts";
import { EvidenceError } from "../errors.ts";
import { FileJobQueue } from "../queue/file-queue.ts";
import { runQueueWorker } from "../queue/worker.ts";
import { generateCertificationKeypair } from "./keys.ts";
import {
  type MatrixRunner,
  mergeReviewerVerdicts,
  orchestrateCertify,
  parseReviewerVerdicts,
  type ReviewerVerdictsDocument,
  resolveGpuQueueExecutor,
} from "./orchestrate.ts";
import type { RollupResult } from "./rollup.ts";
import { verifyCertification } from "./sign.ts";

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const NOW = () => new Date("2026-07-06T12:00:00.000Z");
const KEYPAIR = generateCertificationKeypair();

const tmpDirs: string[] = [];

function tmpDir(prefix = "evidence-orch-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a finalized fixture bundle with the given lane counts + a screenshot. */
async function fixtureBundle(lanes: {
  [lane: string]: { passed: number; failed: number; skipped: number };
}): Promise<string> {
  const sourceDir = tmpDir("evidence-orch-src-");
  const bundle = createBundle({
    rootDir: tmpDir("evidence-orch-runs-"),
    provenance: {
      commit: COMMIT,
      branch: "feat/orch-test",
      runner: "local",
      tier: "cpu",
      envFingerprint: { tier: "cpu" },
    },
    now: NOW,
  });
  let index = 0;
  for (const [lane, counts] of Object.entries(lanes)) {
    const source = path.join(sourceDir, `result-${index}.json`);
    index += 1;
    fs.writeFileSync(source, `${JSON.stringify(counts)}\n`);
    await bundle.addArtifact(source, {
      kind: "report",
      source: "fixture",
      lane,
      producedBy: "orchestrate.test.ts",
      bundlePath: `lanes/${lane}/result.json`,
    });
  }
  await bundle.finalize();
  return bundle.dir;
}

/** A throwaway git repo so `collectGitProvenance` returns a real sha/branch. */
function tmpGitRepo(): string {
  const dir = tmpDir("evidence-orch-git-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

const REVIEWER = {
  kind: "agent",
  id: "orch-test",
  model: "claude-fable-5",
} as const;

function reviewerDoc(
  verdicts: ReviewerVerdictsDocument["verdicts"],
): ReviewerVerdictsDocument {
  return { schema: 1, reviewer: REVIEWER, verdicts };
}

describe("orchestrateCertify — fresh bundle green path", () => {
  it("captures a passing matrix lane, signs, and self-verifies green", async () => {
    const repoRoot = tmpGitRepo();
    const runMatrix: MatrixRunner = async () => ({
      command: "fake-matrix",
      lanes: [
        { lane: "matrix", passed: 42, failed: 0, skipped: 0, log: "ok\n" },
      ],
    });
    const result = await orchestrateCertify({
      tier: "cpu",
      repoRoot,
      outDir: tmpDir("evidence-orch-out-"),
      signingKey: KEYPAIR.privateKeyPem,
      reviewer: REVIEWER,
      runMatrix,
      env: {},
      now: NOW,
    });

    expect(result.overallVerdict).toBe("green");
    expect(result.verify.ok).toBe(true);
    expect(fs.existsSync(result.certPath)).toBe(true);
    // The lane the matrix produced is present as a mechanical pass verdict.
    expect(
      result.certification.verdicts.some(
        (verdict) =>
          verdict.subject === "lane:matrix" && verdict.verdict === "pass",
      ),
    ).toBe(true);
    // The lane result.json is actually in the bundle the cert is bound to.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.bundleDir, "manifest.json"), "utf8"),
    );
    expect(
      manifest.artifacts.some(
        (a: { path: string }) => a.path === "lanes/matrix/result.json",
      ),
    ).toBe(true);

    // Re-verify from disk with the trusted public key — the CI-gate contract.
    const reverify = await verifyCertification(result.certPath, {
      publicKeyPem: KEYPAIR.publicKeyPem,
      bundleDir: result.bundleDir,
      now: NOW,
    });
    expect(reverify.ok).toBe(true);
    expect(reverify.failures).toEqual([]);
  });
});

describe("orchestrateCertify — pre-built bundle", () => {
  it("certifies an existing bundle green via --skip-matrix semantics", async () => {
    const bundleDir = await fixtureBundle({
      matrix: { passed: 10, failed: 0, skipped: 0 },
    });
    const result = await orchestrateCertify({
      tier: "cpu",
      repoRoot: process.cwd(),
      existingBundleDir: bundleDir,
      skipMatrix: true,
      signingKey: KEYPAIR.privateKeyPem,
      reviewerVerdicts: reviewerDoc([
        { subject: "view:home", verdict: "pass", notes: "reviewed by hand" },
      ]),
      now: NOW,
    });
    expect(result.overallVerdict).toBe("green");
    expect(result.certification.reviewer.id).toBe("orch-test");
    // Reviewer-added subject plus the mechanical lane pass are both signed.
    const subjects = result.certification.verdicts.map((v) => v.subject).sort();
    expect(subjects).toEqual(["lane:matrix", "view:home"]);
  });

  it("lets a reviewer waive a mechanically failing lane (with notes) to green", async () => {
    const bundleDir = await fixtureBundle({
      flaky: { passed: 1, failed: 3, skipped: 0 },
    });
    const result = await orchestrateCertify({
      tier: "cpu",
      repoRoot: process.cwd(),
      existingBundleDir: bundleDir,
      signingKey: KEYPAIR.privateKeyPem,
      reviewerVerdicts: reviewerDoc([
        {
          subject: "lane:flaky",
          verdict: "waived",
          notes: "known-flaky lane tracked in #99999; not release-blocking",
        },
      ]),
      now: NOW,
    });
    expect(result.overallVerdict).toBe("green");
    expect(result.verify.ok).toBe(true);
    const waived = result.certification.verdicts.find(
      (v) => v.subject === "lane:flaky",
    );
    expect(waived?.verdict).toBe("waived");
  });
});

describe("orchestrateCertify — red paths", () => {
  it("signs a truthful red certification when a lane fails and is not waived", async () => {
    const bundleDir = await fixtureBundle({
      broken: { passed: 0, failed: 2, skipped: 0 },
    });
    const result = await orchestrateCertify({
      tier: "cpu",
      repoRoot: process.cwd(),
      existingBundleDir: bundleDir,
      signingKey: KEYPAIR.privateKeyPem,
      reviewer: REVIEWER,
      now: NOW,
    });
    expect(result.overallVerdict).toBe("red");
    expect(result.verify.ok).toBe(false);
    expect(result.verify.failures.map((f) => f.code)).toContain(
      "verdict-failures",
    );
    // The cert is still written — a red run does not suppress its own proof.
    expect(fs.existsSync(result.certPath)).toBe(true);
    const reverify = await verifyCertification(result.certPath, {
      publicKeyPem: KEYPAIR.publicKeyPem,
      bundleDir,
      now: NOW,
    });
    expect(reverify.ok).toBe(false);
  });

  it("refuses to flip a mechanically failing lane to pass", async () => {
    const bundleDir = await fixtureBundle({
      broken: { passed: 0, failed: 1, skipped: 0 },
    });
    await expect(
      orchestrateCertify({
        tier: "cpu",
        repoRoot: process.cwd(),
        existingBundleDir: bundleDir,
        signingKey: KEYPAIR.privateKeyPem,
        reviewerVerdicts: reviewerDoc([
          {
            subject: "lane:broken",
            verdict: "pass",
            notes: "looks fine to me",
          },
        ]),
        now: NOW,
      }),
    ).rejects.toThrow(/cannot mark mechanically fail/);
  });

  it("fails verification after the bundle manifest is tampered post-sign", async () => {
    const bundleDir = await fixtureBundle({
      matrix: { passed: 5, failed: 0, skipped: 0 },
    });
    const result = await orchestrateCertify({
      tier: "cpu",
      repoRoot: process.cwd(),
      existingBundleDir: bundleDir,
      signingKey: KEYPAIR.privateKeyPem,
      reviewer: REVIEWER,
      reviewerVerdicts: reviewerDoc([
        { subject: "view:home", verdict: "pass", notes: "ok" },
      ]),
      now: NOW,
    });
    expect(result.overallVerdict).toBe("green");

    // Flip the lane result.json under the signed manifest hash.
    const laneResult = path.join(bundleDir, "lanes", "matrix", "result.json");
    fs.writeFileSync(
      laneResult,
      `${JSON.stringify({ passed: 0, failed: 9, skipped: 0 })}\n`,
    );
    const reverify = await verifyCertification(result.certPath, {
      publicKeyPem: KEYPAIR.publicKeyPem,
      bundleDir,
      now: NOW,
    });
    expect(reverify.ok).toBe(false);
    expect(reverify.failures.map((f) => f.code)).toContain("bundle-tampered");
  });
});

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A throwaway git repo with one screenshot in an ingestable silo. */
function tmpGitRepoWithScreenshot(): string {
  const dir = tmpDir("evidence-orch-gitshot-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  const shotDir = path.join(dir, "e2e-recordings", "login", "desktop");
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(shotDir, "shot.png"), PNG_1X1);
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

/** Stub gpu-vision service: /health + OpenAI /v1/chat/completions. */
function startVisionStub(content: string) {
  const server = createServer((req, res) => {
    if (req.url === "/health") return void res.writeHead(200).end("ok");
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      req.resume();
      req.on("end", () =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ choices: [{ message: { content } }] })),
      );
      return;
    }
    res.writeHead(404).end();
  });
  const started = new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  return { server, started };
}

/** Find the analysis.json in a bundle whose document records `analyzerId`. */
function findAnalysisRecord(
  bundleDir: string,
  analyzerId: string,
): Record<string, unknown> | undefined {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && entry.name.endsWith(".analysis.json")
        ? [full]
        : [];
    });
  for (const file of walk(bundleDir)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const record = doc.results?.[analyzerId];
    if (record !== undefined) return record;
  }
  return undefined;
}

describe("resolveGpuQueueExecutor", () => {
  it("returns an executor only at gpu/full tier with a queue root", () => {
    const root = tmpDir("evidence-orch-qroot-");
    expect(
      resolveGpuQueueExecutor("gpu", { gpuQueueRoot: root } as never),
    ).toBeDefined();
    expect(
      resolveGpuQueueExecutor("full", { gpuQueueRoot: root } as never),
    ).toBeDefined();
    // No root → inline (undefined); cpu tier → inline even with a root.
    expect(resolveGpuQueueExecutor("gpu", {} as never)).toBeUndefined();
    expect(
      resolveGpuQueueExecutor("cpu", { gpuQueueRoot: root } as never),
    ).toBeUndefined();
  });
});

describe("orchestrateCertify — gpu queue wiring (#14543 acceptance)", () => {
  // A passing lane so the rollup has a signable verdict; the screenshot is what
  // the gpu analyzer (routed through the queue) actually analyzes.
  const passingMatrix: MatrixRunner = async () => ({
    command: "fake-matrix",
    lanes: [{ lane: "matrix", passed: 1, failed: 0, skipped: 0, log: "ok\n" }],
  });

  it("routes gpu analyzers through a resident queue worker at --tier gpu", async () => {
    const stub = startVisionStub("# Login\nSign in to Eliza");
    const stubUrl = await stub.started;
    const prevUrl = process.env.ELIZA_GPU_VISION_URL;
    process.env.ELIZA_GPU_VISION_URL = stubUrl;
    const controller = new AbortController();
    const queueRoot = tmpDir("evidence-orch-queue-");
    try {
      const repoRoot = tmpGitRepoWithScreenshot();
      const worker = runQueueWorker({
        queue: new FileJobQueue(queueRoot),
        tier: "gpu",
        signal: controller.signal,
        limits: { pollMs: 20 },
      });

      const result = await orchestrateCertify({
        tier: "gpu",
        repoRoot,
        outDir: tmpDir("evidence-orch-out-"),
        signingKey: KEYPAIR.privateKeyPem,
        reviewer: REVIEWER,
        runMatrix: passingMatrix,
        gpuQueueRoot: queueRoot,
        gpuQueueTimeoutMs: 30_000,
        env: {},
        now: NOW,
      });
      controller.abort();
      await worker;

      // The gpu analyzer's result reached analysis.json via the queue worker —
      // a real OCR transcript, not an inline run and not a fabrication.
      const record = findAnalysisRecord(result.bundleDir, "ocr.unlimited");
      expect(record?.status).toBe("ran");
      expect((record?.data as { text: string }).text).toContain(
        "Sign in to Eliza",
      );
      // The run advertises the queue path in its analyze step.
      const analyzeStep = result.steps.find((s) => s.step === "analyze");
      expect(analyzeStep?.detail).toMatch(/via queue worker/);
    } finally {
      process.env.ELIZA_GPU_VISION_URL = prevUrl;
      controller.abort();
      stub.server.close();
    }
  });

  it("honestly skips gpu analyzers when no worker drains the queue", async () => {
    const prevUrl = process.env.ELIZA_GPU_VISION_URL;
    delete process.env.ELIZA_GPU_VISION_URL;
    try {
      const repoRoot = tmpGitRepoWithScreenshot();
      const result = await orchestrateCertify({
        tier: "gpu",
        repoRoot,
        outDir: tmpDir("evidence-orch-out-"),
        signingKey: KEYPAIR.privateKeyPem,
        reviewer: REVIEWER,
        runMatrix: passingMatrix,
        gpuQueueRoot: tmpDir("evidence-orch-queue-"),
        gpuQueueTimeoutMs: 300, // no worker: fail fast to an honest skip
        env: {},
        now: NOW,
      });

      // No worker consumed the job: an honest skip naming the missing worker,
      // never a fabricated transcript — and the run still produces a cert.
      const record = findAnalysisRecord(result.bundleDir, "ocr.unlimited");
      expect(record?.status).toBe("skipped-missing-tool");
      expect(record?.reason).toMatch(/no gpu queue worker/);
      expect("data" in (record ?? {})).toBe(false);
      expect(fs.existsSync(result.certPath)).toBe(true);
    } finally {
      if (prevUrl !== undefined) process.env.ELIZA_GPU_VISION_URL = prevUrl;
    }
  });
});

describe("mergeReviewerVerdicts", () => {
  const rollup: RollupResult = {
    schema: 1,
    verdicts: [
      {
        subject: "lane:a",
        verdict: "pass",
        evidence: ["lanes/a/result.json"],
        notes: "ok",
      },
      {
        subject: "lane:b",
        verdict: "fail",
        evidence: ["lanes/b/result.json"],
        notes: "failed=1",
      },
    ],
    summary: {
      lanes: [],
      analysesScanned: 0,
      analysisFindings: [],
      missingArtifacts: [],
      counts: { pass: 1, fail: 1, waived: 0 },
    },
  };

  it("carries every rollup subject through and adds reviewer subjects", () => {
    const merged = mergeReviewerVerdicts(rollup, [
      { subject: "lane:b", verdict: "waived", notes: "flaky" },
      { subject: "view:x", verdict: "pass", evidence: [] },
    ]);
    expect(merged.map((v) => v.subject)).toEqual([
      "lane:a",
      "lane:b",
      "view:x",
    ]);
    expect(merged.find((v) => v.subject === "lane:b")?.verdict).toBe("waived");
    // Waived subject keeps the rollup evidence when the override omits it.
    expect(merged.find((v) => v.subject === "lane:b")?.evidence).toEqual([
      "lanes/b/result.json",
    ]);
  });

  it("throws on a false-pass override of a mechanical fail", () => {
    expect(() =>
      mergeReviewerVerdicts(rollup, [{ subject: "lane:b", verdict: "pass" }]),
    ).toThrow(EvidenceError);
  });
});

describe("parseReviewerVerdicts", () => {
  it("rejects a document with no verdicts", () => {
    expect(() =>
      parseReviewerVerdicts({ schema: 1, verdicts: [] }, "test"),
    ).toThrow(/invalid reviewer verdicts/);
  });
  it("rejects an unknown verdict value", () => {
    expect(() =>
      parseReviewerVerdicts(
        { schema: 1, verdicts: [{ subject: "x", verdict: "maybe" }] },
        "test",
      ),
    ).toThrow(/invalid reviewer verdicts/);
  });
});

describe("certify CLI subcommand", () => {
  function captureIo() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
      out,
      err,
    };
  }

  it("exits 0 and writes a verifiable cert over an existing bundle", async () => {
    const bundleDir = await fixtureBundle({
      matrix: { passed: 3, failed: 0, skipped: 0 },
    });
    const keyFile = path.join(tmpDir("evidence-orch-key-"), "key.pem");
    fs.writeFileSync(keyFile, KEYPAIR.privateKeyPem);
    const verdictsFile = path.join(tmpDir("evidence-orch-rv-"), "rv.json");
    fs.writeFileSync(
      verdictsFile,
      JSON.stringify(
        reviewerDoc([{ subject: "view:home", verdict: "pass", notes: "ok" }]),
      ),
    );
    const certOut = path.join(
      tmpDir("evidence-orch-cert-"),
      "certification.json",
    );
    const { io } = captureIo();
    const code = await runCli(
      [
        "certify",
        "--tier",
        "cpu",
        "--bundle",
        bundleDir,
        "--reviewer-id",
        "cli-agent",
        "--reviewer-kind",
        "agent",
        "--key-file",
        keyFile,
        "--reviewer-verdicts",
        verdictsFile,
        "--cert-out",
        certOut,
      ],
      io,
    );
    expect(code).toBe(0);
    expect(fs.existsSync(certOut)).toBe(true);
    const reverify = await verifyCertification(certOut, {
      publicKeyPem: KEYPAIR.publicKeyPem,
      bundleDir,
    });
    expect(reverify.ok).toBe(true);
  });

  it("accepts reviewer identity from the reviewer-verdicts file", async () => {
    const bundleDir = await fixtureBundle({
      matrix: { passed: 3, failed: 0, skipped: 0 },
    });
    const keyFile = path.join(tmpDir("evidence-orch-key-"), "key.pem");
    fs.writeFileSync(keyFile, KEYPAIR.privateKeyPem);
    const verdictsFile = path.join(tmpDir("evidence-orch-rv-"), "rv.json");
    fs.writeFileSync(
      verdictsFile,
      JSON.stringify(
        reviewerDoc([{ subject: "view:home", verdict: "pass", notes: "ok" }]),
      ),
    );
    const certOut = path.join(
      tmpDir("evidence-orch-cert-"),
      "certification.json",
    );
    const { io } = captureIo();
    const code = await runCli(
      [
        "certify",
        "--tier",
        "cpu",
        "--bundle",
        bundleDir,
        "--key-file",
        keyFile,
        "--reviewer-verdicts",
        verdictsFile,
        "--cert-out",
        certOut,
      ],
      io,
    );
    expect(code).toBe(0);
    const cert = JSON.parse(fs.readFileSync(certOut, "utf8"));
    expect(cert.reviewer).toMatchObject({
      kind: "agent",
      id: "orch-test",
    });
  });

  it("exits 1 on a red bundle without waivers", async () => {
    const bundleDir = await fixtureBundle({
      broken: { passed: 0, failed: 1, skipped: 0 },
    });
    const keyFile = path.join(tmpDir("evidence-orch-key-"), "key.pem");
    fs.writeFileSync(keyFile, KEYPAIR.privateKeyPem);
    const { io } = captureIo();
    const code = await runCli(
      [
        "certify",
        "--tier",
        "cpu",
        "--bundle",
        bundleDir,
        "--reviewer-id",
        "cli-agent",
        "--reviewer-kind",
        "agent",
        "--key-file",
        keyFile,
      ],
      io,
    );
    expect(code).toBe(1);
  });
});
