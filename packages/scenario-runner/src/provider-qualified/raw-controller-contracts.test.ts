/**
 * Exercises the shared raw-controller bindings with deterministic data and a
 * real canonical trajectory directory. No fixture is represented as provider
 * qualification or as evidence from an external account.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProviderFailureProbeHashBinding } from "./operator-authorization.ts";
import {
  assertRawReceiptChronology,
  bindValidatedFailureProbeExecutions,
  buildProviderReplayBinding,
  verifyDeployedTrajectoryRun,
} from "./raw-controller-contracts.ts";
import { createRawControllerTrajectoryMaterial } from "./raw-controller-test-fixtures.ts";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

describe("raw provider-controller contracts", () => {
  it("retains exact immutable probe material beside every signed hash", () => {
    const material = {
      probeId: "authorization-denied",
      requestPayload: { operation: "send", nested: { target: "canary" } },
      expectedErrorCode: { code: "denied" },
      scope: { account: "operator" },
      authorizationGrant: { capability: "message.send" },
    };
    const [execution] = bindValidatedFailureProbeExecutions({
      materials: [material],
      bindings: [createProviderFailureProbeHashBinding(material)],
    });
    material.requestPayload.nested.target = "mutated-after-preflight";
    expect(execution.material.requestPayload).toEqual({
      operation: "send",
      nested: { target: "canary" },
    });
    expect(Object.isFrozen(execution.material.requestPayload)).toBe(true);
    expect(execution.binding).toEqual(
      createProviderFailureProbeHashBinding({
        ...material,
        requestPayload: { operation: "send", nested: { target: "canary" } },
      }),
    );
  });

  it("binds replay to the complete original operation correlation tuple", () => {
    const binding = buildProviderReplayBinding({
      scenarioId: "provider.signal.confirmed-send",
      runId: "run-1",
      runNonce: "n".repeat(64),
      ingressRequestId: "ingress-1",
      providerEventId: "message-1",
      effectSha256: sha256("effect"),
      operation: { kind: "signal.message-send", text: "canary" },
    });
    expect(binding).toMatchObject({
      scenarioId: "provider.signal.confirmed-send",
      runId: "run-1",
      originalIngressRequestIdSha256: sha256("ingress-1"),
      originalProviderEventIdSha256: sha256("message-1"),
      originalEffectSha256: sha256("effect"),
    });
    expect(binding.operationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it("rejects stale, future, and inverted receipt intervals", () => {
    const now = Date.now();
    expect(() =>
      assertRawReceiptChronology({
        timestamps: [
          new Date(now).toISOString(),
          new Date(now - 1).toISOString(),
        ],
        collectedAtMs: now,
      }),
    ).toThrow(/chronology is inverted/);
    expect(() =>
      assertRawReceiptChronology({
        timestamps: [
          new Date(now - 16 * 60_000).toISOString(),
          new Date(now).toISOString(),
        ],
        collectedAtMs: now,
      }),
    ).toThrow(/stale or future-dated/);
  });

  it("verifies a real isolated run and rejects arbitrary export metadata", () => {
    const now = Date.now();
    const material = createRawControllerTrajectoryMaterial({
      runId: "run-trajectory",
      scenarioId: "provider.canary",
      baseMs: now,
    });
    const verified = verifyDeployedTrajectoryRun({
      material,
      expectedRunId: "run-trajectory",
      expectedScenarioId: "provider.canary",
      now: new Date(now),
    });
    expect(verified.trajectories).toHaveLength(1);
    expect(verified.setSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      verifyDeployedTrajectoryRun({
        material: {
          exportId: "caller-selected",
          trajectoryCount: 1,
          exportSha256: sha256("unverified"),
        },
        expectedRunId: "run-trajectory",
        expectedScenarioId: "provider.canary",
        now: new Date(now),
      }),
    ).toThrow(/closed shape/);
  });
});
