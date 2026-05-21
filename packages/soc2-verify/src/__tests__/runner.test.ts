import { describe, expect, it } from "vitest";
import { runVerification, hasCriticalFailures } from "../runners/run.js";

describe("runVerification orchestrator", () => {
  it("runs the dynamic-only subset end-to-end", async () => {
    const r = await runVerification({
      elizaRoot: process.cwd(),
      outerRoot: process.cwd(),
      include: ["roundtrip", "audit-dispatcher", "redaction"],
    });
    expect(r.overall.pass + r.overall.fail).toBeGreaterThan(0);
    expect(typeof r.overall.readiness_score).toBe("number");
    expect(typeof r.generated_at).toBe("string");
  });

  it("hasCriticalFailures handles empty report", () => {
    expect(
      hasCriticalFailures({
        generated_at: "x",
        branch: "x",
        commit: "x",
        controls: {},
        overall: { pass: 0, fail: 0, warn: 0, skip: 0, readiness_score: 0 },
      }),
    ).toBe(false);
  });
});
