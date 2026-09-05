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
    expect(
      JSON.parse(
        await readFile(path.join(outputRoot, "stability.json"), "utf8"),
      ),
    ).toEqual(report);
    expect(
      await readFile(path.join(outputRoot, "stability.sha256"), "utf8"),
    ).toMatch(/^[a-f0-9]{64} {2}stability\.json\n$/);
  });
});
