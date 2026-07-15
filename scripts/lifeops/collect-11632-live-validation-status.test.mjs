/**
 * Verifies that #11632 status can only claim live connector evidence when both
 * required Vitest logs contain executed, skip-free test summaries.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveConnectorRowsProven } from "./collect-11632-live-validation-status.mjs";

const GOOGLE_PATH =
  "reports/lifeops-live-validation/11632-status/plugin-google-live.txt";
const X_PATH = "reports/lifeops-live-validation/11632-status/plugin-x-live.txt";

function evidence(path, { passed = 1, failed = 0, skipped = 0 } = {}) {
  return {
    path,
    exists: true,
    vitestCounts: {
      passed,
      failed,
      skipped,
      summaryLines: ["Tests summary"],
    },
  };
}

describe("#11632 live connector proof", () => {
  it("requires both connector rows", () => {
    assert.equal(liveConnectorRowsProven([evidence(GOOGLE_PATH)]), false);
  });

  it("accepts two executed, skip-free connector rows", () => {
    assert.equal(
      liveConnectorRowsProven([evidence(GOOGLE_PATH), evidence(X_PATH)]),
      true,
    );
  });

  it("rejects failures and skips", () => {
    assert.equal(
      liveConnectorRowsProven([
        evidence(GOOGLE_PATH),
        evidence(X_PATH, { skipped: 1 }),
      ]),
      false,
    );
    assert.equal(
      liveConnectorRowsProven([
        evidence(GOOGLE_PATH, { failed: 1 }),
        evidence(X_PATH),
      ]),
      false,
    );
  });
});
