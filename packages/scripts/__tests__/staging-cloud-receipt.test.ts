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
      schemaVersion: 1,
      lane: "app-live-e2e-cloud-staging",
      sourceSha: exactSha,
      workflow: { runId: 32237956456, runAttempt: 1 },
      result: {
        outcome: "success",
        startedAtMs: 1787151674000,
        completedAtMs: 1787151717600,
        durationMs: 43600,
      },
      annotations: {
        cloudApiOrigin: "https://api-staging.eliza.app",
        cloudEnvironment: "staging",
        rendererSource: "local-checkout",
        deployedRendererTested: false,
        loginProvisionChatPassed: true,
      },
    });
  });

  test("records a failed test without claiming login, provision, or chat passed", () => {
    const receipt = createStagingCloudReceipt(args({ outcome: "failure" }));
    expect(receipt.result.outcome).toBe("failure");
    expect(receipt.annotations.loginProvisionChatPassed).toBe(false);
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
