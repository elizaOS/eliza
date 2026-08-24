/** Exercises manifest validation and exact-three artifact semantics with a deterministic injected adapter. */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ScenarioStabilityExecutionAdapter } from "@elizaos/scenario-runner";
import { authorityChildEnvironment } from "./cloud-stability-environment.ts";
import {
  type CloudStabilityManifest,
  canonicalCloudStabilityJson,
  canonicalCloudStabilitySha256,
  parseCloudStabilityManifest,
  runCloudStabilityLane,
  verifyCloudStabilityArtifacts,
} from "./cloud-stability-runner.ts";

const directories: string[] = [];
const manifest: CloudStabilityManifest = {
  schemaVersion: 1,
  runId: "cloud-stability-test",
  mode: "deterministic-mock",
  scenarioId: "cloud-stability-agent",
  provider: "deterministic",
  model: "strict-fixtures",
  scenarioFingerprint: "d".repeat(64),
  worldFingerprint: "e".repeat(64),
  fixtureManifestFingerprint: "a".repeat(64),
  timeoutMs: 1_000,
  maxInputTokens: 100,
  maxOutputTokens: 100,
  maxToolCalls: 10,
};

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Cloud stability manifest", () => {
  test("authority environment drops ambient credentials", () => {
    const environment = authorityChildEnvironment(
      {
        PATH: "/bin",
        OPENAI_API_KEY: "sentinel-model-secret",
        AWS_SECRET_ACCESS_KEY: "sentinel-service-secret",
        DATABASE_URL: "postgres://sentinel",
      },
      "test-namespace",
      "test-control-token-0001",
    );
    expect(environment).toEqual({
      PATH: "/bin",
      TMPDIR: undefined,
      LANG: undefined,
      TZ: "UTC",
      SYNTHETIC_CONTROL_NAMESPACE: "test-namespace",
      SYNTHETIC_CONTROL_TOKEN: "test-control-token-0001",
    });
    expect(JSON.stringify(environment)).not.toContain("sentinel");
  });

  test("rejects accessors and noncanonical identifiers", () => {
    let getterCalled = false;
    const hostile = Object.defineProperty({ ...manifest }, "model", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "strict-fixtures";
      },
    });
    expect(() => parseCloudStabilityManifest(hostile)).toThrow(
      /data properties/,
    );
    expect(getterCalled).toBe(false);
    expect(() =>
      parseCloudStabilityManifest({ ...manifest, runId: "../escape" }),
    ).toThrow(/runId/);
  });

  test("persists exact-three failure evidence and canonical hashes", async () => {
    const outputRoot = await mkdtemp(
      path.join(tmpdir(), "cloud-stability-test-"),
    );
    directories.push(outputRoot);
    const attempts: number[] = [];
    const adapter: ScenarioStabilityExecutionAdapter = {
      async execute(input) {
        attempts.push(input.attemptNumber);
        return {
          passed: input.attemptNumber !== 2,
          initialStateHash: "b".repeat(64),
          finalStateHash: "c".repeat(64),
          inputTokens: 1,
          outputTokens: 1,
          toolCalls: 1,
          evidence: {
            trajectory: [],
            toolReceipts: [],
            stateTransitions: [],
            providerReceipts: [],
            judgeVerdicts: [],
          },
          stateDiff: {},
          ...(input.attemptNumber === 2 ? { error: "deliberate failure" } : {}),
        };
      },
      async terminate() {},
    };
    const report = await runCloudStabilityLane({
      manifest,
      outputRoot,
      adapter,
    });
    expect(attempts).toEqual([1, 2, 3]);
    expect(report.status).toBe("failed");
    expect(report.cells[0]?.passedAttempts).toBe(2);
    const reportBytes = await readFile(path.join(outputRoot, "stability.json"));
    const parsedReport = JSON.parse(reportBytes.toString("utf8"));
    const rawSha256 = createHash("sha256").update(reportBytes).digest("hex");
    expect(parsedReport).toEqual(report);
    expect(reportBytes.toString("utf8")).toBe(
      canonicalCloudStabilityJson(parsedReport),
    );
    expect(rawSha256).toBe(canonicalCloudStabilitySha256(parsedReport));
    expect(
      await readFile(path.join(outputRoot, "stability.sha256"), "utf8"),
    ).toBe(`${rawSha256}  stability.json\n`);
    const artifactManifest = JSON.parse(
      await readFile(path.join(outputRoot, "manifest.json"), "utf8"),
    );
    expect(artifactManifest.reportSha256).toBe(rawSha256);
    expect((await verifyCloudStabilityArtifacts(outputRoot)).report).toEqual(
      report,
    );
  });

  test("rejects modified, truncated, noncanonical, and duplicate-key reports", async () => {
    const outputRoot = await mkdtemp(
      path.join(tmpdir(), "cloud-stability-integrity-test-"),
    );
    directories.push(outputRoot);
    const adapter: ScenarioStabilityExecutionAdapter = {
      async execute() {
        return {
          passed: true,
          initialStateHash: "b".repeat(64),
          finalStateHash: "c".repeat(64),
          inputTokens: 1,
          outputTokens: 1,
          toolCalls: 1,
          evidence: {
            trajectory: [],
            toolReceipts: [],
            stateTransitions: [],
            providerReceipts: [],
            judgeVerdicts: [],
          },
          stateDiff: {},
        };
      },
      async terminate() {},
    };
    await runCloudStabilityLane({ manifest, outputRoot, adapter });
    const reportPath = path.join(outputRoot, "stability.json");
    const checksumPath = path.join(outputRoot, "stability.sha256");
    const manifestPath = path.join(outputRoot, "manifest.json");
    const originalReport = await readFile(reportPath);
    const originalChecksum = await readFile(checksumPath);
    const originalManifest = await readFile(manifestPath);
    const parsedReport = JSON.parse(originalReport.toString("utf8"));

    await writeFile(
      reportPath,
      canonicalCloudStabilityJson({ ...parsedReport, status: "failed" }),
    );
    await expect(verifyCloudStabilityArtifacts(outputRoot)).rejects.toThrow(
      /does not match retained report bytes/,
    );

    await writeFile(reportPath, originalReport.subarray(0, -1));
    await expect(verifyCloudStabilityArtifacts(outputRoot)).rejects.toThrow(
      /not valid JSON/,
    );

    const bindAlteredReport = async (bytes: Buffer): Promise<void> => {
      const reportSha256 = createHash("sha256").update(bytes).digest("hex");
      const artifactManifest = JSON.parse(originalManifest.toString("utf8"));
      await Promise.all([
        writeFile(reportPath, bytes),
        writeFile(checksumPath, `${reportSha256}  stability.json\n`),
        writeFile(
          manifestPath,
          canonicalCloudStabilityJson({
            ...artifactManifest,
            reportSha256,
          }),
        ),
      ]);
    };

    await bindAlteredReport(
      Buffer.from(JSON.stringify(parsedReport, null, 2), "utf8"),
    );
    await expect(verifyCloudStabilityArtifacts(outputRoot)).rejects.toThrow(
      /not canonical JSON/,
    );

    await bindAlteredReport(
      Buffer.from(
        `{"schemaVersion":1,${originalReport.toString("utf8").slice(1)}`,
        "utf8",
      ),
    );
    await expect(verifyCloudStabilityArtifacts(outputRoot)).rejects.toThrow(
      /not canonical JSON/,
    );

    await Promise.all([
      writeFile(reportPath, originalReport),
      writeFile(checksumPath, originalChecksum),
      writeFile(manifestPath, originalManifest),
    ]);
    await expect(
      verifyCloudStabilityArtifacts(outputRoot),
    ).resolves.toMatchObject({
      reportSha256: canonicalCloudStabilitySha256(parsedReport),
    });

    const reportTargetPath = path.join(outputRoot, "stability-target.json");
    await rename(reportPath, reportTargetPath);
    await symlink(reportTargetPath, reportPath);
    await expect(verifyCloudStabilityArtifacts(outputRoot)).rejects.toThrow();
  });
});
