/** Tests fail-closed validation of retained group-chat benchmark evidence. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateGroupChatEvalReport } from "../validate-group-chat-eval-report.ts";

function fixture(options?: { selfGraded?: boolean; omitArtifact?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-chat-evidence-"));
  const scenarioDir = path.join(root, "scenarios");
  const artifactsDir = path.join(root, "artifacts");
  fs.mkdirSync(scenarioDir);
  fs.mkdirSync(artifactsDir);
  for (const [index, id] of ["group.one", "group.two"].entries()) {
    fs.writeFileSync(
      path.join(scenarioDir, `${id}.scenario.ts`),
      "export default {};\n",
    );
    if (!options?.omitArtifact || index === 0) {
      const directory = path.join(artifactsDir, String(index));
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "report.json"), "{}\n");
    }
  }
  const report = path.join(root, "aggregate.json");
  fs.writeFileSync(
    report,
    JSON.stringify({
      providerName: "anthropic",
      totals: { passed: 1, failed: 1, skipped: 0, total: 2 },
      scenarios: [
        { id: "group.one", status: "passed" },
        {
          id: "group.two",
          status: "failed",
          judgeSelfGraded: options?.selfGraded === true,
        },
      ],
    }),
  );
  return { report, artifactsDir, scenarioDir };
}

describe("group-chat evaluation report validation", () => {
  it("accepts complete independent evidence even when benchmark assertions fail", () => {
    expect(
      validateGroupChatEvalReport({ ...fixture(), provider: "anthropic" }),
    ).toEqual({ provider: "anthropic", total: 2, passed: 1, failed: 1 });
  });

  it("rejects self-graded or missing per-scenario evidence", () => {
    expect(() =>
      validateGroupChatEvalReport({
        ...fixture({ selfGraded: true }),
        provider: "anthropic",
      }),
    ).toThrow("self-graded");
    expect(() =>
      validateGroupChatEvalReport({
        ...fixture({ omitArtifact: true }),
        provider: "anthropic",
      }),
    ).toThrow("incomplete");
  });
});
