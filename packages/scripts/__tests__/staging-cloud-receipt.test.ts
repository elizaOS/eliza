/**
 * Contract tests for the staging Cloud live receipt's closed, secret-free schema.
 */
import { describe, expect, test } from "bun:test";
import { createStagingCloudReceipt } from "../write-staging-cloud-receipt.mjs";

const exactSha = "87da9c8ba169440f0fb21dc613f7bc425c8014b6";

function args(overrides: Record<string, string> = {}): string[] {
  const values = {
    output: "/tmp/staging-cloud-receipt.json",
    "source-sha": exactSha,
    "run-id": "32237956456",
    "run-attempt": "1",
    outcome: "success",
    "started-ms": "1787151674000",
    "completed-ms": "1787151717600",
    "first-turn-latency-ms": "12345",
    "continuity-evidence": "verified",
    ...overrides,
  };
  return Object.entries(values).flatMap(([name, value]) => [
    `--${name}`,
    value,
  ]);
}

describe("staging Cloud live receipt", () => {
  test("binds successful evidence to the exact SHA, run, duration, and fixed annotations", () => {
    expect(createStagingCloudReceipt(args())).toEqual({
      schemaVersion: 2,
      lane: "app-live-e2e-cloud-staging",
      sourceSha: exactSha,
      workflow: { runId: 32237956456, runAttempt: 1 },
      result: {
        outcome: "success",
        startedAtMs: 1787151674000,
        completedAtMs: 1787151717600,
        durationMs: 43600,
      },
      measurements: {
        firstTurnLatencyDefinition:
          "composer-send-click-to-settled-valid-assistant-turn: starts immediately before the UI send click; ends after the same fresh non-empty assistant row settles and passes the liveness contract; not first-token latency",
        firstTurnLatencyMs: 12345,
      },
      continuity: {
        verified: true,
        challengeTurnCount: 1,
        noAdditionalChatSendAfterChallenge: true,
        personalIdentityEndpointPassed: true,
        reloadHistoryPassed: true,
        freshContextHistoryPassed: true,
        personalIdentityReused: true,
        runtimeBindingReused: true,
        apiBaseReused: true,
        forbiddenAgentMutationCount: 0,
      },
      cleanup: {
        cleanupDisposition: "no-test-owned-agent",
        conversationHistoryDisposition: "preserved",
      },
      annotations: {
        cloudApiOrigin: "https://api-staging.eliza.app",
        cloudEnvironment: "staging",
        rendererSource: "local-checkout",
        deployedRendererTested: false,
        loginPersonalIdentityChatPassed: true,
        historyContinuityPassed: true,
      },
    });
  });

  test("records a failed test without claiming login, identity, or chat passed", () => {
    const receipt = createStagingCloudReceipt(
      args({
        outcome: "failure",
        "first-turn-latency-ms": "unavailable",
        "continuity-evidence": "unavailable",
      }),
    );
    expect(receipt.result.outcome).toBe("failure");
    expect(receipt.measurements.firstTurnLatencyMs).toBeNull();
    expect(receipt.continuity).toEqual({
      verified: false,
      challengeTurnCount: null,
      noAdditionalChatSendAfterChallenge: null,
      personalIdentityEndpointPassed: null,
      reloadHistoryPassed: null,
      freshContextHistoryPassed: null,
      personalIdentityReused: null,
      runtimeBindingReused: null,
      apiBaseReused: null,
      forbiddenAgentMutationCount: null,
    });
    expect(receipt.cleanup).toEqual({
      cleanupDisposition: "unavailable",
      conversationHistoryDisposition: "unavailable",
    });
    expect(receipt.annotations.loginPersonalIdentityChatPassed).toBe(false);
    expect(receipt.annotations.historyContinuityPassed).toBe(false);
  });

  test("requires independently verified continuity on success and forbids it on failure", () => {
    expect(() =>
      createStagingCloudReceipt(args({ "continuity-evidence": "unavailable" })),
    ).toThrow("requires verified continuity-evidence");
    expect(() =>
      createStagingCloudReceipt(
        args({ "continuity-evidence": "anything-else" }),
      ),
    ).toThrow("requires verified continuity-evidence");
    expect(() =>
      createStagingCloudReceipt(
        args({
          outcome: "failure",
          "first-turn-latency-ms": "unavailable",
          "continuity-evidence": "verified",
        }),
      ),
    ).toThrow("must mark continuity-evidence unavailable");
  });

  test("requires a separate validated-reply measurement on success and forbids one on failure", () => {
    expect(() =>
      createStagingCloudReceipt(
        args({ "first-turn-latency-ms": "unavailable" }),
      ),
    ).toThrow("successful outcome requires");
    expect(() =>
      createStagingCloudReceipt(args({ "first-turn-latency-ms": "0" })),
    ).toThrow("positive integer");
    for (const invalidLatency of [
      "-1",
      "1.5",
      "1e3",
      "NaN",
      "9007199254740992",
    ]) {
      expect(() =>
        createStagingCloudReceipt(
          args({ "first-turn-latency-ms": invalidLatency }),
        ),
      ).toThrow(/positive integer|safe integer range/);
    }
    expect(() =>
      createStagingCloudReceipt(args({ "first-turn-latency-ms": "43601" })),
    ).toThrow("must not exceed the whole lane duration");
    expect(() =>
      createStagingCloudReceipt(
        args({
          outcome: "failure",
          "first-turn-latency-ms": "12345",
        }),
      ),
    ).toThrow("failed outcome must mark");
  });

  test("rejects abbreviated SHAs, invalid outcomes, and impossible timing", () => {
    expect(() =>
      createStagingCloudReceipt(args({ "source-sha": exactSha.slice(0, 8) })),
    ).toThrow("exact lowercase 40-hex commit SHA");
    expect(() =>
      createStagingCloudReceipt(args({ outcome: "skipped" })),
    ).toThrow("outcome must be success or failure");
    expect(() =>
      createStagingCloudReceipt(
        args({
          "started-ms": "1787151717600",
          "completed-ms": "1787151674000",
        }),
      ),
    ).toThrow("must not precede");
  });

  test("rejects unknown inputs so credentials and raw responses cannot enter the artifact", () => {
    expect(() =>
      createStagingCloudReceipt([...args(), "--bearer", "secret"]),
    ).toThrow("unsupported argument: --bearer");
    expect(() =>
      createStagingCloudReceipt([...args(), "--raw-response", "{}"]),
    ).toThrow("unsupported argument: --raw-response");

    const serialized = JSON.stringify(createStagingCloudReceipt(args()));
    expect(serialized).not.toMatch(
      /bearer|authorization|api.?key|response|reply/i,
    );
  });
});
