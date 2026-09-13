/**
 * Exercises the production stability process-group adapter with real child
 * processes and an injected deterministic control-session boundary. No child
 * process or environment transport is mocked. Native lease controls inject the
 * external acceptance decision; real cryptographic ownership is tested by the
 * Cloud guardian integration.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SyntheticControlSession } from "@elizaos/shared/synthetic-control";
import { afterEach, describe, expect, it } from "vitest";
import { createScenarioStabilityPlan } from "./stability.ts";
import { executeScenarioStability } from "./stability-executor.ts";
import { ScenarioStabilitySubprocessAdapter } from "./stability-subprocess-adapter.ts";

const CHILD_SCRIPT = `
const { createHmac } = require("node:crypto");
const { closeSync, fstatSync, readFileSync, readSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
let bootstrapIdentity;
const readBootstrap = () => {
  const bootstrapStat = fstatSync(3);
  bootstrapIdentity = String(bootstrapStat.dev) + ":" + String(bootstrapStat.ino);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.alloc(16384);
      const count = readSync(3, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > 131072) process.exit(96);
      chunks.push(chunk.subarray(0, count));
    }
  } finally {
    closeSync(3);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const realBootstrap = process.env.ELIZA_STABILITY_MODEL_MODE === "real-llm" ? readBootstrap() : undefined;
const meterAttestationKey = realBootstrap?.meterAttestationKey;
if (process.platform === "linux" && realBootstrap) {
  const initialEnvironment = readFileSync("/proc/self/environ");
  if (initialEnvironment.includes(Buffer.from(realBootstrap.credentialValue)) || initialEnvironment.includes(Buffer.from(meterAttestationKey))) process.exit(97);
}
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
const attest = (receipt) => {
  if (process.env.ELIZA_TEST_ACCEPTED_AFTER_REJECT === "1") {
    receipt.requestEnvelopes = [{ ...receipt.requestEnvelopes[0], requestNumber: 2, forwardedBodyBytes: null, forwardedBodySha256: null, accepted: false, failureCode: "STABILITY_MODEL_REQUEST_BUDGET_EXCEEDED" }, receipt.requestEnvelopes[0]];
  }
  const key = process.env.ELIZA_TEST_WRONG_ATTESTATION_KEY === "1" ? "wrong-attestation-key" : meterAttestationKey;
  const signed = { ...receipt, attestation: createHmac("sha256", key).update(canonical(receipt)).digest("hex") };
  if (process.env.ELIZA_TEST_FORGE_AFTER_ATTESTATION === "1") signed.requestEnvelopes[0].forwardedBodySha256 = "b".repeat(64);
  return signed;
};
if (process.env.ELIZA_STABILITY_METER_ATTESTATION_KEY || (process.env.ELIZA_STABILITY_MODEL_MODE === "real-llm" && process.env.OPENAI_API_KEY)) process.exit(93);
if (process.env.ELIZA_TEST_INHERITANCE_PROBE === "1" && process.env.ELIZA_SYNTHETIC_GENERATION === "1") {
  const inheritanceProbe = spawnSync(process.execPath, ["-e", "const fs=require('node:fs');if(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||process.env.ELIZA_STABILITY_METER_ATTESTATION_KEY)process.exit(1);try{const stat=fs.fstatSync(3);if(String(stat.dev)+':'+String(stat.ino)===process.env.ELIZA_TEST_BOOTSTRAP_IDENTITY)process.exit(2)}catch{}process.exit(0)"], { env: { ...process.env, ELIZA_TEST_BOOTSTRAP_IDENTITY: bootstrapIdentity }, stdio: ["ignore", "pipe", "pipe"] });
  if (inheritanceProbe.status !== 0) process.exit(94);
}
if (process.env.ELIZA_STABILITY_MODEL_MODE === "deterministic-mock" && process.env.OPENAI_API_KEY) {
  process.exit(91);
}
if (process.env.ELIZA_REQUIRE_MOCK_SERVICES !== "1") process.exit(92);
if (process.env.ELIZA_TEST_PRINT_SECRETS === "1") {
  process.stderr.write(String(process.env.ELIZA_SYNTHETIC_CONTROL_TOKEN) + " " + String(realBootstrap?.credentialValue || "") + " " + String(meterAttestationKey || ""));
}
const hash = process.env.ELIZA_STABILITY_AUTHORITY_INITIAL_STATE_HASH;
const meterFailureCode = process.env.ELIZA_TEST_METER_FAILURE;
const preDispatchFailure = meterFailureCode === "STABILITY_MODEL_PRE_DISPATCH_REJECTED";
const inputTokens = process.env.ELIZA_TEST_ZERO_REAL === "1" || preDispatchFailure || meterFailureCode === "STABILITY_MODEL_USAGE_MISSING" || meterFailureCode === "STABILITY_MODEL_USAGE_MALFORMED" ? 0 : meterFailureCode === "STABILITY_MODEL_TOKEN_BUDGET_EXCEEDED" ? 12 : 4;
const outputTokens = preDispatchFailure || meterFailureCode === "STABILITY_MODEL_USAGE_MISSING" || meterFailureCode === "STABILITY_MODEL_USAGE_MALFORMED" ? 0 : 2;
const requestCount = process.env.ELIZA_TEST_OVER_CAP_REAL === "1" ? 3 : preDispatchFailure ? 0 : 1;
process.stdout.write(JSON.stringify({
  passed: !meterFailureCode,
  initialStateHash: hash,
  finalStateHash: "b".repeat(64),
  inputTokens,
  outputTokens,
  toolCalls: 1,
  evidence: {
    trajectory: [{ model: process.env.ELIZA_STABILITY_MODEL }],
    toolReceipts: [{ name: "SEND_MESSAGE" }],
    stateTransitions: [{ status: "sent" }],
    providerReceipts: process.env.ELIZA_STABILITY_MODEL_MODE === "deterministic-mock" ? [{
      fixtureMode: "strict-fixtures",
      fixtureManifestFingerprint: process.env.ELIZA_STRICT_FIXTURE_MANIFEST_FINGERPRINT,
      unmatchedCalls: 0,
      ambiguousCalls: 0,
      unusedRequiredFixtures: 0,
      overconsumedFixtures: 0
    }, ...(process.env.ELIZA_TEST_DUPLICATE_FIXTURE === "1" ? [{
      fixtureMode: "strict-fixtures",
      fixtureManifestFingerprint: process.env.ELIZA_STRICT_FIXTURE_MANIFEST_FINGERPRINT,
      unmatchedCalls: 0,
      ambiguousCalls: 0,
      unusedRequiredFixtures: 0,
      overconsumedFixtures: 1
    }] : [])] : [attest({
      receiptType: "eliza.stability.real-llm.v1",
      provider: process.env.ELIZA_TEST_WRONG_REAL === "1" ? "wrong-provider" : process.env.ELIZA_STABILITY_PROVIDER,
      model: process.env.ELIZA_STABILITY_MODEL,
      liveModelInvoked: requestCount > 0,
      requestCount,
      inputTokens,
      outputTokens,
      meteringFailures: meterFailureCode ? [{ code: meterFailureCode, message: meterFailureCode + " retained", requestNumber: 1 }] : [],
      requestEnvelopes: preDispatchFailure ? [{
        requestNumber: 1,
        method: "POST",
        route: "/v1/responses",
        bodyBytes: 64,
        forwardedBodyBytes: null,
        forwardedBodySha256: null,
        observedModel: process.env.ELIZA_STABILITY_MODEL,
        requestedMaxOutputTokens: 1,
        effectiveMaxOutputTokens: null,
        inputBudgetCharge: 8256,
        accepted: false,
        failureCode: meterFailureCode
      }] : Array.from({ length: requestCount }, (_, index) => ({
        requestNumber: index + (process.env.ELIZA_TEST_BAD_ENVELOPE_SEQUENCE === "1" ? 2 : 1),
        method: "POST",
        route: "/v1/responses",
        bodyBytes: 64,
        forwardedBodyBytes: process.env.ELIZA_TEST_BAD_ENVELOPE_BYTES === "1" ? 65 : 64,
        forwardedBodySha256: process.env.ELIZA_TEST_BAD_ENVELOPE_HASH === "1" ? "not-a-hash" : "a".repeat(64),
        observedModel: process.env.ELIZA_TEST_WRONG_ENVELOPE_MODEL === "1" ? "wrong-model" : process.env.ELIZA_STABILITY_MODEL,
        requestedMaxOutputTokens: 2,
        effectiveMaxOutputTokens: 2,
        inputBudgetCharge: 8256,
        accepted: true,
        ...(process.env.ELIZA_TEST_EXTRA_ENVELOPE_KEY === "1" ? { extra: true } : {})
      })),
      namespace: process.env.ELIZA_SYNTHETIC_NAMESPACE,
      manifestId: process.env.ELIZA_SYNTHETIC_MANIFEST_ID,
      generation: Number(process.env.ELIZA_SYNTHETIC_GENERATION),
      unexpectedRealServiceCalls: 0,
      unexpectedNetworkCalls: 0
    })],
    judgeVerdicts: [{ passed: true }]
  },
  stateDiff: { sent: true },
  ...(meterFailureCode ? { error: meterFailureCode } : {})
}));
`;

describe("scenario stability subprocess adapter", () => {
  const roots: string[] = [];
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  function root(): string {
    const value = mkdtempSync(path.join(tmpdir(), "stability-subprocess-"));
    roots.push(value);
    return value;
  }

  it.each(["accepted", "rejected"] as const)(
    "requires the independent native lease to be %s after real FD4 delivery",
    async (mode) => {
      const outputRoot = root();
      const manifest = {
        version: 1 as const,
        namespace: "native-lease",
        manifestId: "native-lease-world",
        domains: {},
      };
      let delivered = 0;
      let cancelled = 0;
      const adapter = new ScenarioStabilitySubprocessAdapter({
        command: process.execPath,
        args: () => [
          "-e",
          `{
          const fs = require("node:fs");
          const admission = JSON.parse(fs.readFileSync(4, "utf8"));
          fs.closeSync(4);
          fs.writeFileSync(admission.marker, admission.value, { flag: "wx" });
        }
` + CHILD_SCRIPT,
        ],
        cwd: outputRoot,
        modelMode: {
          kind: "deterministic-mock",
          fixtureManifestFingerprint: "f".repeat(64),
        },
        syntheticControl: {
          controlUrl: "http://127.0.0.1:43191",
          controlToken: "owned-lease-token",
          manifest,
        },
        openSession: async () =>
          ({
            manifest,
            generation: 1,
            execute: async () => ({ manifest }),
            close: async () => undefined,
          }) as unknown as SyntheticControlSession,
        nativeAdmission: {
          async prepare(input) {
            const marker = path.join(
              input.outputDir,
              "native-bootstrap-received",
            );
            let timer: ReturnType<typeof setInterval>;
            let rejectPending: (error: Error) => void;
            const completion = new Promise<{
              schema: "eliza.stability.native-reference.v1";
              attestationSha256: string;
            }>((resolve, reject) => {
              rejectPending = reject;
              timer = setInterval(() => {
                if (!existsSync(marker)) return;
                clearInterval(timer);
                if (readFileSync(marker, "utf8") !== input.attemptId) {
                  reject(
                    new Error("Native bootstrap bytes changed during delivery"),
                  );
                  return;
                }
                delivered += 1;
                if (mode === "rejected")
                  reject(new Error("owned native persistence rejected"));
                else
                  resolve({
                    schema: "eliza.stability.native-reference.v1",
                    attestationSha256: "a".repeat(64),
                  });
              }, 10);
            });
            return {
              bootstrap: JSON.stringify({ marker, value: input.attemptId }),
              completion,
              async cancel() {
                clearInterval(timer);
                rejectPending(new Error("owned lease cancelled"));
                cancelled += 1;
              },
            };
          },
        },
      });
      const report = await executeScenarioStability({
        plan: createScenarioStabilityPlan({
          runId: "native-lease-" + mode,
          outputRoot,
        }),
        targets: [
          {
            scenarioId: "owned-native-lease",
            model: { provider: "deterministic", model: "strict-fixtures" },
          },
        ],
        budgets: {
          timeoutMs: 5000,
          maxInputTokens: 10,
          maxOutputTokens: 10,
          maxToolCalls: 2,
        },
        adapter,
      });
      expect(delivered).toBe(3);
      expect(cancelled).toBe(3);
      expect(report.status).toBe(mode === "accepted" ? "passed" : "failed");
      for (const attempt of report.cells[0].attempts) {
        expect(attempt.passed).toBe(mode === "accepted");
        if (mode === "accepted")
          expect(attempt.evidence.native?.attestationSha256).toBe(
            "a".repeat(64),
          );
        else expect(attempt.evidence.native).toBeUndefined();
      }
    },
  );

  it("blocks the next attempt while timed-out teardown still owns its session", async () => {
    const outputRoot = root();
    const manifest = {
      version: 1 as const,
      namespace: "pending-cleanup",
      manifestId: "pending-cleanup",
      domains: {},
    };
    let opened = 0;
    let closed = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new ScenarioStabilitySubprocessAdapter({
      command: process.execPath,
      args: () => ["-e", CHILD_SCRIPT],
      cwd: outputRoot,
      modelMode: {
        kind: "deterministic-mock",
        fixtureManifestFingerprint: "f".repeat(64),
      },
      syntheticControl: {
        controlUrl: "http://127.0.0.1:43191",
        controlToken: "owned-pending-cleanup",
        manifest,
      },
      openSession: async () =>
        ({
          manifest,
          generation: ++opened,
          execute: async () => ({ manifest }),
          close: async () => {
            closed += 1;
            await barrier;
          },
        }) as unknown as SyntheticControlSession,
    });
    let report:
      | Awaited<ReturnType<typeof executeScenarioStability>>
      | undefined;
    let openedWhileBlocked = 0;
    let closedWhileBlocked = 0;
    try {
      report = await executeScenarioStability({
        plan: createScenarioStabilityPlan({
          runId: "pending-cleanup",
          outputRoot,
        }),
        targets: [
          {
            scenarioId: "owned-child",
            model: { provider: "deterministic", model: "strict-fixtures" },
          },
        ],
        budgets: {
          timeoutMs: 500,
          maxInputTokens: 10,
          maxOutputTokens: 10,
          maxToolCalls: 2,
        },
        adapter,
      });
      openedWhileBlocked = opened;
      closedWhileBlocked = closed;
    } finally {
      release();
      if (report)
        for (const attempt of report.cells[0].attempts)
          await adapter.terminate({
            target: report.cells[0],
            attemptNumber: attempt.attemptNumber,
            attemptId: attempt.attemptId,
            outputDir: attempt.outputDir,
            signal: AbortSignal.abort(),
          });
    }
    expect(openedWhileBlocked).toBe(1);
    expect(closedWhileBlocked).toBe(1);
    expect(report?.cells[0].attempts[1].error).toContain(
      "teardown is in progress",
    );
    expect(report?.cells[0].attempts[2].error).toContain(
      "teardown is in progress",
    );
  });

  it.each(["session", "native lease"] as const)(
    "owns a %s that arrives after execution has timed out",
    async (acquisition) => {
      const outputRoot = root();
      const manifest = {
        version: 1 as const,
        namespace: "late-session",
        manifestId: "late-session",
        domains: {},
      };
      let opened = 0,
        created = 0,
        closed = 0,
        childCommands = 0;
      let leaseCreated = 0,
        leaseCancelled = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const opening: Promise<void>[] = [];
      const adapter = new ScenarioStabilitySubprocessAdapter({
        command: process.execPath,
        args: () => {
          childCommands += 1;
          return ["-e", CHILD_SCRIPT];
        },
        cwd: outputRoot,
        modelMode: {
          kind: "deterministic-mock",
          fixtureManifestFingerprint: "f".repeat(64),
        },
        syntheticControl: {
          controlUrl: "http://127.0.0.1:43191",
          controlToken: "owned-late-session",
          manifest,
        },
        nativeAdmission:
          acquisition === "native lease"
            ? {
                async prepare() {
                  const ready = barrier.then(() => {
                    leaseCreated += 1;
                  });
                  opening.push(ready);
                  await ready;
                  return {
                    bootstrap: "{}",
                    completion: Promise.resolve({
                      schema: "eliza.stability.native-reference.v1" as const,
                      attestationSha256: "a".repeat(64),
                    }),
                    async cancel() {
                      leaseCancelled += 1;
                    },
                  };
                },
              }
            : undefined,
        openSession: async () => {
          const generation = ++opened;
          if (acquisition === "session") {
            const ready = barrier.then(() => undefined);
            opening.push(ready);
            await ready;
          }
          created += 1;
          return {
            manifest,
            generation,
            execute: async () => ({ manifest }),
            close: async () => {
              closed += 1;
            },
          } as unknown as SyntheticControlSession;
        },
      });
      let report:
        | Awaited<ReturnType<typeof executeScenarioStability>>
        | undefined;
      let automaticallyClosed = 0;
      try {
        report = await executeScenarioStability({
          plan: createScenarioStabilityPlan({
            runId: "late-session",
            outputRoot,
          }),
          targets: [
            {
              scenarioId: "owned-child",
              model: { provider: "deterministic", model: "strict-fixtures" },
            },
          ],
          budgets: {
            timeoutMs: 100,
            maxInputTokens: 10,
            maxOutputTokens: 10,
            maxToolCalls: 2,
          },
          adapter,
        });
        const pending = adapter.terminate({
          target: report.cells[0],
          attemptNumber: report.cells[0].attempts[0].attemptNumber,
          attemptId: report.cells[0].attempts[0].attemptId,
          outputDir: report.cells[0].attempts[0].outputDir,
          signal: AbortSignal.abort(),
        });
        release();
        await pending;
        await Promise.all(opening);
        await Promise.resolve();
        automaticallyClosed = closed;
      } finally {
        release();
        await Promise.all(opening);
        await Promise.resolve();
        if (report)
          for (const attempt of report.cells[0].attempts)
            await adapter.terminate({
              target: report.cells[0],
              attemptNumber: attempt.attemptNumber,
              attemptId: attempt.attemptId,
              outputDir: attempt.outputDir,
              signal: AbortSignal.abort(),
            });
      }
      expect(opened).toBe(1);
      expect(created).toBe(1);
      expect(automaticallyClosed).toBe(1);
      expect(childCommands).toBe(0);
      if (acquisition === "native lease") {
        expect(leaseCreated).toBe(1);
        expect(leaseCancelled).toBe(1);
      }
    },
  );

  it("runs exactly three isolated keyless process groups over one exact manifest", async () => {
    process.env.OPENAI_API_KEY = "ambient-credential-must-not-cross";
    const outputRoot = root();
    const manifest = {
      version: 1 as const,
      namespace: "stability-test",
      manifestId: "exact-manifest-v1",
      domains: { messages: [{ id: "seed-message" }] },
    };
    let generation = 0;
    let closed = 0;
    const adapter = new ScenarioStabilitySubprocessAdapter({
      command: process.execPath,
      args: () => ["-e", CHILD_SCRIPT],
      cwd: outputRoot,
      modelMode: {
        kind: "deterministic-mock",
        fixtureManifestFingerprint: "f".repeat(64),
      },
      syntheticControl: {
        controlUrl: "http://127.0.0.1:43191",
        controlToken: "internal-control-token",
        manifest,
      },
      mockServiceUrls: {
        ELIZA_MOCK_MESSAGES_URL: "http://127.0.0.1:43192/messages",
      },
      env: { ELIZA_TEST_PRINT_SECRETS: "1" },
      openSession: async (options) => {
        expect(options.manifest).toBe(manifest);
        generation += 1;
        return {
          manifest,
          generation,
          async execute() {
            return { manifest, messages: [{ id: "seed-message" }] };
          },
          async close() {
            closed += 1;
          },
        } as unknown as SyntheticControlSession;
      },
    });

    const report = await executeScenarioStability({
      plan: createScenarioStabilityPlan({
        runId: "keyless-process-groups",
        outputRoot,
      }),
      targets: [
        {
          scenarioId: "send-seeded-message",
          model: { provider: "deterministic", model: "strict-fixtures" },
        },
      ],
      budgets: {
        timeoutMs: 5_000,
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolCalls: 2,
      },
      adapter,
    });

    expect(generation).toBe(3);
    expect(closed).toBe(3);
    expect(report).toMatchObject({
      status: "passed",
      attemptCount: 3,
      requiredTier: "3/3",
      cells: [
        {
          firstAttemptPassed: true,
          passedAttempts: 3,
          tier: "3/3",
          strictPassed: true,
          baselineInitialStateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    const receipts = report.cells[0]?.attempts.map((attempt) =>
      attempt.evidence.providerReceipts.at(-1),
    );
    expect(receipts).toEqual([
      expect.objectContaining({
        isolation: "subprocess-process-group",
        generation: 1,
        modelMode: "deterministic-mock",
        manifestId: "exact-manifest-v1",
      }),
      expect.objectContaining({ generation: 2 }),
      expect.objectContaining({ generation: 3 }),
    ]);
    for (const attempt of report.cells[0]?.attempts ?? []) {
      const stderr = readFileSync(
        path.join(attempt.outputDir, "subprocess.stderr.log"),
        "utf8",
      );
      expect(stderr).not.toContain("internal-control-token");
      expect(stderr).toContain("[REDACTED_SECRET]");
    }
  });

  it("kills a SIGTERM-resistant descendant group before resetting every attempt", async () => {
    const outputRoot = root();
    const manifest = {
      version: 1 as const,
      namespace: "descendant-test",
      manifestId: "descendant-test-v1",
      domains: {},
    };
    let generation = 0;
    let closed = 0;
    const descendantScript = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(process.env.ELIZA_STABILITY_OUTPUT_DIR + "/grandchild.pid", String(child.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const adapter = new ScenarioStabilitySubprocessAdapter({
      command: process.execPath,
      args: () => ["-e", descendantScript],
      cwd: outputRoot,
      modelMode: {
        kind: "deterministic-mock",
        fixtureManifestFingerprint: "f".repeat(64),
      },
      syntheticControl: {
        controlUrl: "http://127.0.0.1:43191",
        controlToken: "internal-control-token",
        manifest,
      },
      openSession: async () => {
        generation += 1;
        return {
          manifest,
          generation,
          async execute() {
            return { ready: true };
          },
          async close() {
            closed += 1;
          },
        } as unknown as SyntheticControlSession;
      },
    });
    const plan = createScenarioStabilityPlan({
      runId: "descendant-timeout",
      outputRoot,
    });
    const report = await executeScenarioStability({
      plan,
      targets: [
        {
          scenarioId: "hang",
          model: { provider: "deterministic", model: "strict" },
        },
      ],
      budgets: {
        timeoutMs: 1_000,
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolCalls: 1,
      },
      adapter,
    });

    expect(report.cells[0]).toMatchObject({ tier: "0/3", strictPassed: false });
    expect(
      closed,
      JSON.stringify(report.cells[0]?.attempts.map((attempt) => attempt.error)),
    ).toBe(3);
    for (const attempt of report.cells[0]?.attempts ?? []) {
      const pid = Number(
        readFileSync(path.join(attempt.outputDir, "grandchild.pid"), "utf8"),
      );
      const deadline = Date.now() + 2_000;
      let absent = false;
      while (!absent && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          // error-policy:J1 ESRCH is the process-boundary's expected absence proof.
          absent = true;
        }
        if (!absent) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(absent).toBe(true);
    }
  });

  it("rejects duplicate deterministic receipts and pre-existing output symlinks", async () => {
    const outputRoot = root();
    const outside = root();
    const plan = createScenarioStabilityPlan({
      runId: "symlink-and-duplicate",
      outputRoot,
    });
    symlinkSync(outside, plan.attempts[0].outputDir);
    const manifest = {
      version: 1 as const,
      namespace: "strict-test",
      manifestId: "strict-v1",
      domains: {},
    };
    let generation = 0;
    const adapter = new ScenarioStabilitySubprocessAdapter({
      command: process.execPath,
      args: () => ["-e", CHILD_SCRIPT],
      cwd: outputRoot,
      env: { ELIZA_TEST_DUPLICATE_FIXTURE: "1" },
      modelMode: {
        kind: "deterministic-mock",
        fixtureManifestFingerprint: "f".repeat(64),
      },
      syntheticControl: {
        controlUrl: "http://127.0.0.1:43191",
        controlToken: "token",
        manifest,
      },
      openSession: async () =>
        ({
          manifest,
          generation: ++generation,
          async execute() {
            return { ready: true };
          },
          async close() {},
        }) as unknown as SyntheticControlSession,
    });
    const report = await executeScenarioStability({
      plan,
      targets: [
        {
          scenarioId: "strict",
          model: { provider: "deterministic", model: "strict" },
        },
      ],
      budgets: {
        timeoutMs: 2_000,
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolCalls: 2,
      },
      adapter,
    });
    expect(report.cells[0]).toMatchObject({ tier: "0/3", strictPassed: false });
    expect(report.cells[0]?.attempts[0]?.error).toContain("symlink");
    expect(report.cells[0]?.attempts[1]?.error).toContain("exactly one");
  });

  it("rejects real-service credentials in keyless mock configuration", () => {
    const outputRoot = root();
    expect(
      () =>
        new ScenarioStabilitySubprocessAdapter({
          command: process.execPath,
          args: () => ["-e", CHILD_SCRIPT],
          cwd: outputRoot,
          modelMode: {
            kind: "deterministic-mock",
            fixtureManifestFingerprint: "f".repeat(64),
          },
          syntheticControl: {
            controlUrl: "http://127.0.0.1:43191",
            controlToken: "internal-control-token",
            manifest: {
              version: 1,
              namespace: "credential-test",
              manifestId: "credential-test-v1",
              domains: {},
            },
          },
          env: { SLACK_BOT_TOKEN: "must-not-be-used" },
        }),
    ).toThrow("real credential seam");
  });

  it("accepts one metered real-LLM receipt and rejects wrong or zero metering", async () => {
    for (const failure of [
      "none",
      "wrong-provider",
      "wrong-envelope-model",
      "bad-envelope-hash",
      "bad-envelope-bytes",
      "bad-envelope-sequence",
      "extra-envelope-key",
      "wrong-attestation-key",
      "post-attestation-forgery",
      "accepted-after-reject",
      "zero-metering",
      "over-request-cap",
    ] as const) {
      const outputRoot = root();
      const manifest = {
        version: 1 as const,
        namespace: `real-${failure}`,
        manifestId: `real-${failure}-v1`,
        domains: {},
      };
      let generation = 0;
      const adapter = new ScenarioStabilitySubprocessAdapter({
        command: process.execPath,
        args: () => ["-e", CHILD_SCRIPT],
        cwd: outputRoot,
        modelMode: {
          kind: "real-llm",
          credentialEnv: "OPENAI_API_KEY",
          credentialValue: "dummy-model-key",
        },
        syntheticControl: {
          controlUrl: "http://127.0.0.1:43191",
          controlToken: "control-secret",
          manifest,
        },
        mockServiceUrls: {
          ELIZA_MOCK_MESSAGES_URL: "http://127.0.0.1:43192/messages",
        },
        env: {
          ELIZA_TEST_PRINT_SECRETS: "1",
          ...(failure === "none" ? { ELIZA_TEST_INHERITANCE_PROBE: "1" } : {}),
          ...(failure === "wrong-provider"
            ? { ELIZA_TEST_WRONG_REAL: "1" }
            : {}),
          ...(failure === "wrong-envelope-model"
            ? { ELIZA_TEST_WRONG_ENVELOPE_MODEL: "1" }
            : {}),
          ...(failure === "bad-envelope-hash"
            ? { ELIZA_TEST_BAD_ENVELOPE_HASH: "1" }
            : {}),
          ...(failure === "bad-envelope-bytes"
            ? { ELIZA_TEST_BAD_ENVELOPE_BYTES: "1" }
            : {}),
          ...(failure === "bad-envelope-sequence"
            ? { ELIZA_TEST_BAD_ENVELOPE_SEQUENCE: "1" }
            : {}),
          ...(failure === "extra-envelope-key"
            ? { ELIZA_TEST_EXTRA_ENVELOPE_KEY: "1" }
            : {}),
          ...(failure === "wrong-attestation-key"
            ? { ELIZA_TEST_WRONG_ATTESTATION_KEY: "1" }
            : {}),
          ...(failure === "post-attestation-forgery"
            ? { ELIZA_TEST_FORGE_AFTER_ATTESTATION: "1" }
            : {}),
          ...(failure === "accepted-after-reject"
            ? { ELIZA_TEST_ACCEPTED_AFTER_REJECT: "1" }
            : {}),
          ...(failure === "zero-metering" ? { ELIZA_TEST_ZERO_REAL: "1" } : {}),
          ...(failure === "over-request-cap"
            ? { ELIZA_TEST_OVER_CAP_REAL: "1" }
            : {}),
        },
        openSession: async () =>
          ({
            manifest,
            generation: ++generation,
            async execute() {
              return { ready: true };
            },
            async close() {},
          }) as unknown as SyntheticControlSession,
      });
      const report = await executeScenarioStability({
        plan: createScenarioStabilityPlan({
          runId: `real-${failure}`,
          outputRoot,
        }),
        targets: [
          {
            scenarioId: "live",
            model: { provider: "openai", model: "gpt-test" },
          },
        ],
        budgets: {
          timeoutMs: 10_000,
          maxInputTokens: 10_000,
          maxOutputTokens: 10,
          maxModelRequests: 2,
          maxToolCalls: 2,
        },
        adapter,
      });
      expect(
        report.cells[0]?.tier,
        JSON.stringify(
          report.cells[0]?.attempts.map((attempt) => attempt.error),
        ),
      ).toBe(failure === "none" ? "3/3" : "0/3");
      if (failure === "none") {
        for (const attempt of report.cells[0]?.attempts ?? []) {
          const stderr = readFileSync(
            path.join(attempt.outputDir, "subprocess.stderr.log"),
            "utf8",
          );
          expect(stderr).not.toContain("dummy-model-key");
          expect(stderr).not.toContain("control-secret");
          expect(stderr).not.toMatch(/[a-f0-9]{64}/u);
        }
      } else {
        expect(report.cells[0]?.attempts[0]?.error).toContain(
          "exact mock-world invocation receipt",
        );
      }
    }
  });

  it.each([
    ["STABILITY_MODEL_PRE_DISPATCH_REJECTED", 0, 0, 0],
    ["STABILITY_MODEL_USAGE_MISSING", 0, 0, 1],
    ["STABILITY_MODEL_USAGE_MALFORMED", 0, 0, 1],
    ["STABILITY_MODEL_TOKEN_BUDGET_EXCEEDED", 12, 2, 1],
  ] as const)(
    "retains authentic failed real-model evidence for %s",
    async (meterFailureCode, expectedInputTokens, expectedOutputTokens, expectedRequestCount) => {
      const outputRoot = root();
      const manifest = {
        version: 1 as const,
        namespace: `real-failure-${meterFailureCode}`,
        manifestId: `real-failure-${meterFailureCode}-v1`,
        domains: {},
      };
      let generation = 0;
      const adapter = new ScenarioStabilitySubprocessAdapter({
        command: process.execPath,
        args: () => ["-e", CHILD_SCRIPT],
        cwd: outputRoot,
        modelMode: {
          kind: "real-llm",
          credentialEnv: "OPENAI_API_KEY",
          credentialValue: "dummy-model-key",
        },
        syntheticControl: {
          controlUrl: "http://127.0.0.1:43191",
          controlToken: "control-secret",
          manifest,
        },
        mockServiceUrls: {
          ELIZA_MOCK_MESSAGES_URL: "http://127.0.0.1:43192/messages",
        },
        env: { ELIZA_TEST_METER_FAILURE: meterFailureCode },
        openSession: async () =>
          ({
            manifest,
            generation: ++generation,
            async execute() {
              return { ready: true };
            },
            async close() {},
          }) as unknown as SyntheticControlSession,
      });
      const report = await executeScenarioStability({
        plan: createScenarioStabilityPlan({
          runId: `real-failure-${meterFailureCode}`,
          outputRoot,
        }),
        targets: [
          {
            scenarioId: "live-failure",
            model: { provider: "openai", model: "gpt-test" },
          },
        ],
        budgets: {
          timeoutMs: 2_000,
          maxInputTokens: 10_000,
          maxOutputTokens: 10,
          maxModelRequests: 2,
          maxToolCalls: 2,
        },
        adapter,
      });

      expect(report.cells[0]?.tier).toBe("0/3");
      expect(report.focusList[0]?.failedAttemptIds).toHaveLength(3);
      expect(report.failureClusters).toEqual([
        expect.objectContaining({
          occurrences: 3,
          sample: meterFailureCode,
        }),
      ]);
      for (const attempt of report.cells[0]?.attempts ?? []) {
        expect(attempt).toMatchObject({
          passed: false,
          error: meterFailureCode,
          inputTokens: expectedInputTokens,
          outputTokens: expectedOutputTokens,
        });
        expect(
          attempt.evidence.providerReceipts.find(
            (receipt) =>
              (receipt as { receiptType?: unknown }).receiptType ===
              "eliza.stability.real-llm.v1",
          ),
        ).toMatchObject({
          requestCount: expectedRequestCount,
          inputTokens: expectedInputTokens,
          outputTokens: expectedOutputTokens,
          meteringFailures: [
            expect.objectContaining({ code: meterFailureCode }),
          ],
        });
      }
    },
  );

  it("allows one explicit model credential only in real-llm mode", () => {
    const outputRoot = root();
    expect(
      () =>
        new ScenarioStabilitySubprocessAdapter({
          command: process.execPath,
          args: () => ["-e", CHILD_SCRIPT],
          cwd: outputRoot,
          modelMode: {
            kind: "real-llm",
            credentialEnv: "OPENAI_API_KEY",
            credentialValue: "model-key",
          },
          syntheticControl: {
            controlUrl: "http://127.0.0.1:43191",
            controlToken: "internal-control-token",
            manifest: {
              version: 1,
              namespace: "real-model-test",
              manifestId: "real-model-test-v1",
              domains: {},
            },
          },
          mockServiceUrls: {
            ELIZA_MOCK_MESSAGES_URL: "https://real-service.example/messages",
          },
        }),
    ).toThrow("credential-free loopback HTTP URL");
  });

  it("rejects a mock service DNS name with a loopback-looking prefix", () => {
    const outputRoot = root();
    expect(
      () =>
        new ScenarioStabilitySubprocessAdapter({
          command: process.execPath,
          args: () => ["-e", CHILD_SCRIPT],
          cwd: outputRoot,
          modelMode: {
            kind: "deterministic-mock",
            fixtureManifestFingerprint: "f".repeat(64),
          },
          syntheticControl: {
            controlUrl: "http://127.0.0.1:43191",
            controlToken: "internal-control-token",
            manifest: {
              version: 1,
              namespace: "loopback-prefix-test",
              manifestId: "loopback-prefix-test-v1",
              domains: {},
            },
          },
          mockServiceUrls: {
            ELIZA_MOCK_MESSAGES_URL: "http://127.attacker.invalid/messages",
          },
        }),
    ).toThrow("credential-free loopback HTTP URL");
  });
});
