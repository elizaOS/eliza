/** Exercises manifest validation and exact-three artifact semantics with a deterministic injected adapter. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ScenarioStabilityExecutionAdapter } from "@elizaos/scenario-runner";
import { authorityChildEnvironment } from "./cloud-stability-environment.ts";
import {
  type CloudStabilityManifest,
  parseCloudStabilityManifest,
  runCloudStabilityLane,
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
  maxModelRequests: 16,
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
        expect(input.budgets.maxModelRequests).toBe(manifest.maxModelRequests);
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
    expect(
      JSON.parse(
        await readFile(path.join(outputRoot, "stability.json"), "utf8"),
      ),
    ).toEqual(report);
    expect(
      await readFile(path.join(outputRoot, "stability.sha256"), "utf8"),
    ).toMatch(/^[a-f0-9]{64} {2}stability\.json\n$/);
  });

  test("retains metering failures in the exact-three focus report", async () => {
    const outputRoot = await mkdtemp(
      path.join(tmpdir(), "cloud-stability-metering-test-"),
    );
    directories.push(outputRoot);
    const { fixtureManifestFingerprint: _fixtureFingerprint, ...baseManifest } =
      manifest;
    const report = await runCloudStabilityLane({
      manifest: {
        ...baseManifest,
        mode: "real-llm",
        provider: "openai",
        model: "gpt-test",
      },
      outputRoot,
      adapter: {
        async execute() {
          return {
            passed: false,
            initialStateHash: "b".repeat(64),
            finalStateHash: "c".repeat(64),
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: 0,
            evidence: {
              trajectory: [],
              toolReceipts: [],
              stateTransitions: [],
              providerReceipts: [],
              judgeVerdicts: [],
            },
            stateDiff: {
              providerUsage: {
                requestCount: 1,
                inputTokens: 0,
                outputTokens: 0,
                failures: [
                  { code: "STABILITY_MODEL_USAGE_MISSING", requestNumber: 1 },
                ],
              },
            },
            error: "STABILITY_MODEL_USAGE_MISSING",
          };
        },
        async terminate() {},
      },
    });
    expect(report.cells[0]).toMatchObject({ tier: "0/3", passedAttempts: 0 });
    expect(report.focusList[0]?.failedAttemptIds).toHaveLength(3);
    expect(report.failureClusters[0]?.sample).toContain(
      "STABILITY_MODEL_USAGE_MISSING",
    );
    expect(report.cells[0]?.attempts).toHaveLength(3);
  });
});
