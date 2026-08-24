/** Verifies deterministic, fail-closed design-system compliance accounting. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComplianceReport,
  compareToBaseline,
  RULES,
  renderComplianceMarkdown,
  resolvesToCanonical,
} from "./check-design-system.mjs";

test("compliance inventory is deterministic and covers every governed rule", () => {
  const now = new Date("2026-08-24T00:00:00Z");
  const first = buildComplianceReport({ now });
  const second = buildComplianceReport({ now });

  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(first.counts), RULES);
  assert.ok(first.scannedFiles > 800);
  assert.equal(
    first.findings.some((finding) => finding.file.includes("/__e2e__/")),
    false,
  );
  assert.equal(
    first.findings.some(
      (finding) =>
        finding.rule === "visual-override" &&
        finding.symbol === "Tabs" &&
        finding.file.endsWith("/SecretsManagerSection.tsx"),
    ),
    false,
  );
  assert.equal(first.counts["atomic-duplicate"], 0);
  assert.equal(first.counts["raw-control"], 0);
  assert.equal(
    first.findings.some(
      (finding) =>
        finding.rule === "visual-override" &&
        finding.symbol === "Skeleton" &&
        finding.file.startsWith("packages/ui/src/components/accounts/"),
    ),
    false,
  );
  assert.equal(first.counts["unstyled-canonical"], 0);
});

test("supported UI barrels resolve to canonical atoms without relying on debt", () => {
  const sourceFile = new URL(
    "../../../plugins/plugin-calendar/src/components/CalendarSection.tsx",
    import.meta.url,
  ).pathname;

  for (const origin of [
    "@elizaos/ui",
    "@elizaos/ui/components",
    "@elizaos/ui/cloud-ui",
  ]) {
    assert.equal(
      resolvesToCanonical({ imported: "Button", origin }, sourceFile),
      true,
    );
  }
});

test("baseline comparison rejects increases and permits reductions", () => {
  const report = buildComplianceReport({
    now: new Date("2026-08-24T00:00:00Z"),
  });
  const equal = { schemaVersion: 1, counts: { ...report.counts } };
  assert.deepEqual(compareToBaseline(report, equal), []);

  const reducedAllowance = {
    schemaVersion: 1,
    counts: {
      ...report.counts,
      "raw-control": report.counts["raw-control"] - 1,
    },
  };
  assert.deepEqual(compareToBaseline(report, reducedAllowance), [
    `raw-control: ${report.counts["raw-control"]} > ${reducedAllowance.counts["raw-control"]}`,
  ]);
});

test("markdown exposes counts and source evidence", () => {
  const report = buildComplianceReport({
    now: new Date("2026-08-24T00:00:00Z"),
  });
  const markdown = renderComplianceMarkdown(report);
  assert.match(markdown, /Design-system compliance report/);
  assert.match(markdown, /atomic-duplicate/);
  assert.match(markdown, /packages\//);
});
