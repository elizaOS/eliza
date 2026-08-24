/** Verifies deterministic, fail-closed design-system compliance accounting. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyExceptions,
  buildComplianceReport,
  compareToBaseline,
  compareToTightBaseline,
  RULES,
  renderComplianceMarkdown,
  resolvesToCanonical,
  scanSourceText,
  validateExceptions,
} from "./check-design-system.mjs";

test("dynamic class expressions cannot hide canonical visual overrides", () => {
  const file = new URL("../src/__scanner-fixture__.tsx", import.meta.url)
    .pathname;
  const findings = scanSourceText({
    file,
    source: `
      import { Button } from "@elizaos/ui";
      const selectedClassName = "border-white";
      export function Fixture({ active }) {
        const style = { borderColor: "white" };
        return (<>
          <Button
            className={cn("w-full", active ? selectedClassName : "bg-surface")}
          >Run</Button>
          <Button style={style}>Stop</Button>
          <Button className={styles.button}>Pause</Button>
        </>);
      }
    `,
  });

  assert.equal(
    findings.filter(
      (finding) =>
        finding.rule === "visual-override" && finding.symbol === "Button",
    ).length,
    3,
  );
});

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

test("tight baseline comparison rejects stale allowances", () => {
  const report = buildComplianceReport({
    now: new Date("2026-08-24T00:00:00Z"),
  });
  const stale = {
    schemaVersion: 1,
    counts: {
      ...report.counts,
      "visual-override": report.counts["visual-override"] + 1,
    },
  };

  assert.deepEqual(compareToTightBaseline(report, stale), [
    `visual-override: actual ${report.counts["visual-override"]} != baseline ${stale.counts["visual-override"]}`,
  ]);
});

test("exceptions must be valid, current, exact, and used", () => {
  const now = new Date("2026-08-24T00:00:00Z");
  const valid = {
    schemaVersion: 1,
    exceptions: [
      {
        id: "native-window-button",
        rule: "raw-control",
        file: "packages/ui/src/native/window.tsx",
        symbol: "button",
        owner: "native-platform",
        reason: "The native host requires this element.",
        reviewBy: "2026-11-24",
        matchCount: 1,
        lines: [10],
      },
    ],
  };
  const exceptions = validateExceptions(valid, now);
  const finding = {
    rule: "raw-control",
    file: "packages/ui/src/native/window.tsx",
    line: 10,
    symbol: "button",
    detail: "fixture",
  };
  assert.deepEqual(applyExceptions([finding], exceptions), []);
  assert.throws(
    () =>
      applyExceptions(
        [{ ...finding, file: "packages/ui/src/native/other.tsx" }],
        exceptions,
      ),
    /expected 1 match\(es\), found 0/,
  );
  assert.throws(
    () =>
      validateExceptions(
        {
          ...valid,
          exceptions: [{ ...valid.exceptions[0], reviewBy: "2026-08-23" }],
        },
        now,
      ),
    /Stale design-system exception/,
  );
  assert.throws(
    () => validateExceptions({ schemaVersion: 1, exceptions: [{}] }, now),
    /Invalid design-system exception/,
  );
});

test("markdown exposes counts and either source evidence or a zero-debt result", () => {
  const report = buildComplianceReport({
    now: new Date("2026-08-24T00:00:00Z"),
  });
  const markdown = renderComplianceMarkdown(report);
  assert.match(markdown, /Design-system compliance report/);
  assert.match(markdown, /atomic-duplicate/);
  assert.match(markdown, /Scanned \d+ governed React source files/);
  if (report.findings.length > 0) assert.match(markdown, /packages\//);
  else assert.match(markdown, /### visual-override\n\nNone\./);
});
