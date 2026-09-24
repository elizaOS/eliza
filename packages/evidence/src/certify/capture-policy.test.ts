/** Real filesystem, Git, ingestion and signing regressions for certification run selection and model opt-in. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { verifyBundle } from "../bundle.ts";
import { generateCertificationKeypair } from "./keys.ts";
import { type CertifyOptions, orchestrateCertify } from "./orchestrate.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(): CertifyOptions {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "certify-run-"));
  dirs.push(repoRoot);
  execFileSync("git", ["init", "--initial-branch", "test"], { cwd: repoRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "fixture",
    ],
    { cwd: repoRoot },
  );
  return {
    repoRoot,
    tier: "cpu",
    signingKey: generateCertificationKeypair().privateKeyPem,
    reviewer: { kind: "human", id: "test" },
    env: {
      ELIZA_VISION_QA_BACKEND: "invalid-must-not-be-resolved",
      ANTHROPIC_API_KEY: "fixture",
    },
  };
}
function writeProducer(root: string, file: string, content: string) {
  const dir = path.join(root, "packages", "app", "test-results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}
it("excludes stale artifacts, preserves pre-run inventory, and never infers paid review from credentials", async () => {
  const options = fixture();
  writeProducer(options.repoRoot, "old.log", "old");
  const result = await orchestrateCertify({
    ...options,
    runMatrix: async () => {
      writeProducer(options.repoRoot, "new.log", "new");
      return {
        command: "fixture",
        lanes: [{ lane: "test", passed: 1, failed: 0, skipped: 0, log: "ok" }],
      };
    },
  });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(result.bundleDir, "manifest.json"), "utf8"),
  );
  const paths = manifest.artifacts.map(
    (artifact: { path: string }) => artifact.path,
  );
  expect(paths.some((file: string) => file.endsWith("new.log"))).toBe(true);
  expect(paths.some((file: string) => file.endsWith("old.log"))).toBe(false);
  expect(paths).toContain("certify/pre-run-inventory.json");
  expect(result.steps.find((step) => step.step === "vision-qa")).toMatchObject({
    status: "skipped",
    detail: expect.stringContaining("not requested"),
  });
  expect((await verifyBundle(result.bundleDir)).ok).toBe(true);
});
it("retains explicit skip-matrix adoption of existing producer output", async () => {
  const options = fixture();
  writeProducer(options.repoRoot, "adopted.log", "existing");
  writeProducer(
    options.repoRoot,
    "result.json",
    JSON.stringify({ passed: 1, failed: 0, skipped: 0 }),
  );
  const result = await orchestrateCertify({
    ...options,
    skipMatrix: true,
    requirements: {
      schema: 1,
      artifacts: [{ subject: "adopted", path: "lanes/e2e/logs/adopted.log" }],
    },
  });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(result.bundleDir, "manifest.json"), "utf8"),
  );
  expect(
    manifest.artifacts.some((artifact: { path: string }) =>
      artifact.path.endsWith("adopted.log"),
    ),
  ).toBe(true);
  expect(result.steps.find((step) => step.step === "matrix")?.status).toBe(
    "skipped",
  );
});
it("resolves the backend only after explicit model-review opt-in", async () => {
  await expect(
    orchestrateCertify({ ...fixture(), skipMatrix: true, visionQa: true }),
  ).rejects.toThrow(/invalid ELIZA_VISION_QA_BACKEND/);
});
it("rejects bundle output inside producer roots before executing the matrix", async () => {
  const options = fixture();
  const runMatrix = vi.fn();
  await expect(
    orchestrateCertify({
      ...options,
      outDir: path.join(
        options.repoRoot,
        "packages",
        "app",
        "test-results",
        "nested",
      ),
      runMatrix,
    }),
  ).rejects.toThrow();
  expect(runMatrix).not.toHaveBeenCalled();
});
