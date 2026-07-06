/**
 * Certify CLI tests. Most paths drive `runCertifyCli` with a captured writer;
 * the full keygen → rollup → sign → verify → tamper → verify-fails pipeline
 * additionally runs end-to-end through real `bun` child processes (execFile)
 * against a real bundle, exactly as the CI gate and a certifier would run it.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createBundle } from "../bundle.ts";
import { runCertifyCli } from "./cli.ts";
import type { CertificationVerifyReport } from "./sign.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "cli.ts",
);
const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-certify-cli-"));
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

async function fixtureBundle(): Promise<string> {
  const sourceDir = tmpDir();
  const results: Record<string, object> = {
    server: { passed: 5, failed: 0, skipped: 0 },
    client: { passed: 2, failed: 0, skipped: 0 },
  };
  const bundle = createBundle({
    rootDir: tmpDir(),
    provenance: {
      commit: COMMIT,
      branch: "feat/cli-certify-test",
      runner: "local",
      tier: "cpu",
      envFingerprint: { tier: "cpu" },
    },
  });
  for (const [lane, result] of Object.entries(results)) {
    const sourcePath = path.join(sourceDir, `${lane}.json`);
    fs.writeFileSync(sourcePath, JSON.stringify(result));
    await bundle.addArtifact(sourcePath, {
      kind: "report",
      source: "cli-test",
      lane,
      producedBy: "cli.test.ts",
      bundlePath: `lanes/${lane}/result.json`,
    });
  }
  await bundle.finalize();
  return bundle.dir;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("bun", [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    // error-policy:J3 non-zero exit is an expected outcome under test; the
    // helper returns it as data instead of an exception.
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

function pemBlock(text: string, label: string): string {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  expect(start, `${label} block present`).toBeGreaterThanOrEqual(0);
  expect(stop).toBeGreaterThan(start);
  return `${text.slice(start, stop + end.length)}\n`;
}

describe("runCertifyCli (in-process)", () => {
  it("keygen never prints the private key without the explicit flag", async () => {
    const { io, outLines, errLines } = capture();
    const code = await runCertifyCli(["keygen"], io);
    expect(code).toBe(0);
    const all = [...outLines, ...errLines].join("\n");
    expect(all).toContain("BEGIN PUBLIC KEY");
    expect(all).toContain("fingerprint: ");
    expect(all).not.toContain("PRIVATE KEY");
  });

  it("rejects unknown arguments and missing required flags with usage", async () => {
    for (const argv of [
      ["rollup"],
      ["sign", "--bundle", "x"],
      ["verify"],
      ["verify", "--cert", "x"],
      ["rollup", "--bundle", "x", "--bogus"],
      ["nonsense"],
    ]) {
      const { io, errLines } = capture();
      const code = await runCertifyCli(argv, io);
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("Usage:");
    }
  });

  it("sign refuses a tampered bundle before touching the key", async () => {
    const bundleDir = await fixtureBundle();
    fs.writeFileSync(
      path.join(bundleDir, "lanes", "server", "result.json"),
      JSON.stringify({ passed: 999, failed: 0, skipped: 0 }),
    );
    const verdictsPath = path.join(tmpDir(), "verdicts.json");
    fs.writeFileSync(
      verdictsPath,
      JSON.stringify({
        schema: 1,
        verdicts: [{ subject: "lane:server", verdict: "pass", evidence: [] }],
      }),
    );
    const { io, errLines } = capture();
    const code = await runCertifyCli(
      [
        "sign",
        "--bundle",
        bundleDir,
        "--verdicts",
        verdictsPath,
        "--reviewer-id",
        "test",
        "--reviewer-kind",
        "human",
      ],
      io,
    );
    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("SIGN_BUNDLE_TAMPERED");
  });
});

describe("certify CLI end-to-end (execFile)", () => {
  it("keygen → rollup → sign → verify green, then tamper → verify red", {
    timeout: 180_000,
  }, async () => {
    // 1. keygen: capture both halves; write the public half via --pubkey-out.
    const pubkeyPath = path.join(tmpDir(), "trusted.pem");
    const keygen = await runCli([
      "keygen",
      "--print-private-key",
      "--pubkey-out",
      pubkeyPath,
    ]);
    expect(keygen.code).toBe(0);
    expect(keygen.stderr).toContain("WARNING");
    const privatePem = pemBlock(keygen.stdout, "PRIVATE KEY");
    expect(fs.readFileSync(pubkeyPath, "utf8")).toContain("BEGIN PUBLIC KEY");
    const signingEnv = {
      ELIZA_CERT_SIGNING_KEY: Buffer.from(privatePem, "utf8").toString(
        "base64",
      ),
    };

    // 2. rollup: draft verdicts from the real bundle.
    const bundleDir = await fixtureBundle();
    const verdictsPath = path.join(tmpDir(), "verdicts.json");
    const rollup = await runCli([
      "rollup",
      "--bundle",
      bundleDir,
      "--out",
      verdictsPath,
    ]);
    expect(rollup.code).toBe(0);
    const draft = JSON.parse(fs.readFileSync(verdictsPath, "utf8"));
    expect(draft.summary.counts).toEqual({ pass: 2, fail: 0, waived: 0 });

    // 3. sign from the env key (base64-wrapped ingress).
    const sign = await runCli(
      [
        "sign",
        "--bundle",
        bundleDir,
        "--verdicts",
        verdictsPath,
        "--reviewer-id",
        "cli-e2e",
        "--reviewer-kind",
        "agent",
        "--reviewer-model",
        "claude-fable-5",
      ],
      signingEnv,
    );
    expect(sign.code).toBe(0);
    expect(sign.stdout).toContain("certification written:");
    expect(sign.stdout).not.toContain("PRIVATE");
    const certPath = path.join(bundleDir, "certification.json");
    expect(fs.existsSync(certPath)).toBe(true);

    // 4. verify: the exact CI-gate invocation, machine-readable.
    const verify = await runCli([
      "verify",
      "--cert",
      certPath,
      "--bundle",
      bundleDir,
      "--pubkey",
      pubkeyPath,
      "--expected-commit",
      COMMIT,
      "--max-age-hours",
      "72",
      "--required-tier",
      "cpu",
      "--json",
    ]);
    expect(verify.code).toBe(0);
    const report = JSON.parse(verify.stdout) as CertificationVerifyReport;
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.certification?.reviewer.id).toBe("cli-e2e");

    // 5. tamper with an artifact; the same invocation must go red with the
    //    specific code, still exiting 1 with a machine-readable report.
    fs.writeFileSync(
      path.join(bundleDir, "lanes", "server", "result.json"),
      JSON.stringify({ passed: 5, failed: 0, skipped: 0, forged: 1 }),
    );
    const tampered = await runCli([
      "verify",
      "--cert",
      certPath,
      "--bundle",
      bundleDir,
      "--pubkey",
      pubkeyPath,
      "--expected-commit",
      COMMIT,
      "--json",
    ]);
    expect(tampered.code).toBe(1);
    const tamperedReport = JSON.parse(
      tampered.stdout,
    ) as CertificationVerifyReport;
    expect(tamperedReport.ok).toBe(false);
    expect(tamperedReport.failures.map((failure) => failure.code)).toContain(
      "bundle-tampered",
    );
  });
});
