/** Verifies deterministic, fail-closed design-system compliance accounting. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeTokenRoleClasses,
  applyExceptions,
  assertCanonicalRecipeContractsSeen,
  assertRegisteredAdaptersUsed,
  auditCanonicalTokenRoles,
  buildComplianceReport,
  compareToBaseline,
  compareToTightBaseline,
  extractButtonAxisDefinitions,
  findUnderusedButtonAxes,
  RULES,
  renderComplianceMarkdown,
  resolvesToCanonical,
  scanButtonAxisUsages,
  scanSourceText,
  validateAdapterRegistry,
  validateExceptions,
} from "./check-design-system.mjs";

test("registered adapters own local recipes without creating a caller escape hatch", () => {
  const file = new URL(
    "../src/components/__scanner-adapter__.tsx",
    import.meta.url,
  ).pathname;
  const relativeFile = "packages/ui/src/components/__scanner-adapter__.tsx";
  const adapter = {
    file: relativeFile,
    symbol: "RegisteredAdapter",
    primitive: "Button",
    role: "action",
    owner: "scanner fixture",
    reason: "Exercises exact adapter ownership.",
    matchCount: 1,
  };
  const key = `${relativeFile}:RegisteredAdapter:Button`;
  const adapterMatches = new Map();
  const adapterExports = new Set();
  const findings = scanSourceText({
    adapterExports,
    adapterMatches,
    file,
    registeredAdapters: new Map([[key, adapter]]),
    source: `
      import { Button } from "@elizaos/ui/button";
      const recipe = "bg-card text-txt";
      export function RegisteredAdapter() {
        return <Button className={recipe}>Owned</Button>;
      }
      export function BorrowingCaller() {
        return <Button className={recipe}>Borrowed</Button>;
      }
    `,
  });

  assertRegisteredAdaptersUsed([adapter], adapterMatches, adapterExports);
  assert.equal(
    findings.filter((finding) => finding.rule === "visual-override").length,
    1,
  );
  assert.equal(findings.at(-1)?.line, 8);
});

test("token roles reject raw colors, wrong channels, and unconstrained transitions", () => {
  assert.deepEqual(
    analyzeTokenRoleClasses({
      className:
        "bg-card text-txt border-border rounded-sm px-3 hover:bg-surface",
      role: "action",
    }),
    [],
  );
  const violations = analyzeTokenRoleClasses({
    className:
      "bg-white text-black border-txt bg-brand-orange shadow-xl transition-all",
    role: "field",
  });
  assert.ok(violations.some((detail) => detail.includes("raw color")));
  assert.ok(
    violations.some((detail) => detail.includes("recognized semantic token")),
  );
  assert.ok(violations.some((detail) => detail.includes("border family")));
  assert.ok(violations.some((detail) => detail.includes("elevation family")));
  assert.ok(violations.some((detail) => detail.includes("transition-all")));
});

test("canonical recipe roles are fail-closed and converge semantic aliases", () => {
  const file = new URL("../src/components/ui/button.tsx", import.meta.url)
    .pathname;
  const result = auditCanonicalTokenRoles({
    file,
    source: `
      const buttonVariants = cva("text-txt", {
        variants: {
          variant: { first: "text-foreground", second: "text-txt" },
          size: { default: "h-10 px-4" },
          shape: { default: "rounded-sm" },
          align: { center: "text-center" },
        },
      });
    `,
  });
  assert.equal(
    result.findings.filter(
      (finding) => finding.rule === "equivalent-recipe-divergence",
    ).length,
    1,
  );

  const unknown = auditCanonicalTokenRoles({
    file: file.replace("button.tsx", "__scanner-role__.tsx"),
    source: `const bespokeVariants = cva("bg-card", { variants: { mood: { calm: "text-txt" } } });`,
  });
  assert.match(unknown.findings[0]?.detail ?? "", /no token-role contract/);
  assert.throws(
    () => assertCanonicalRecipeContractsSeen(new Set()),
    /Stale canonical token-role contracts/,
  );
});

test("registered adapter internals must obey their declared token role", () => {
  const file = new URL(
    "../src/components/__scanner-role-adapter__.tsx",
    import.meta.url,
  ).pathname;
  const relativeFile =
    "packages/ui/src/components/__scanner-role-adapter__.tsx";
  const adapter = {
    file: relativeFile,
    symbol: "RawAdapter",
    primitive: "Button",
    role: "action",
    owner: "scanner fixture",
    reason: "Exercises token-role ownership.",
    matchCount: 1,
  };
  const findings = scanSourceText({
    file,
    registeredAdapters: new Map([
      [`${relativeFile}:RawAdapter:Button`, adapter],
    ]),
    source: `
      import { Button } from "@elizaos/ui/button";
      export function RawAdapter() {
        return <Button className="bg-white text-black">Owned</Button>;
      }
    `,
  });
  assert.equal(
    findings.filter((finding) => finding.rule === "token-role-misuse").length,
    2,
  );
});

test("adapter registry rejects unknown primitives and stale entries", () => {
  assert.throws(
    () =>
      validateAdapterRegistry({
        schemaVersion: 1,
        adapters: [
          {
            file: "packages/ui/src/example.tsx",
            symbol: "Example",
            primitive: "ImaginaryControl",
            role: "action",
            owner: "fixture",
            reason: "Unknown primitive fixture.",
            matchCount: 1,
          },
        ],
      }),
    /Invalid design-system adapter/,
  );
  assert.throws(
    () =>
      validateAdapterRegistry({
        schemaVersion: 1,
        adapters: [
          {
            file: "packages/ui/src/example.tsx",
            symbol: "Example",
            primitive: "Button",
            role: "product-one-off",
            owner: "fixture",
            reason: "Unknown role fixture.",
            matchCount: 1,
          },
        ],
      }),
    /Invalid design-system adapter/,
  );
  const stale = {
    file: "packages/ui/src/example.tsx",
    symbol: "MissingAdapter",
    primitive: "Button",
    role: "action",
    owner: "fixture",
    reason: "Stale adapter fixture.",
    matchCount: 1,
  };
  assert.throws(
    () => assertRegisteredAdaptersUsed([stale], new Map(), new Set()),
    /must name an exported symbol/,
  );
  const key = `${stale.file}:${stale.symbol}:${stale.primitive}`;
  assert.throws(
    () =>
      assertRegisteredAdaptersUsed(
        [stale],
        new Map([[key, 2]]),
        new Set([key]),
      ),
    /expected 1 canonical composition\(s\), found 2/,
  );
});

test("Button axes require two maintained call sites", () => {
  const buttonFile = new URL(
    "../src/components/ui/__scanner-button__.tsx",
    import.meta.url,
  ).pathname;
  const { definitions, defaults } = extractButtonAxisDefinitions({
    file: buttonFile,
    source: `
      const buttonVariants = cva("base", {
        variants: {
          variant: { default: "default", shared: "shared", oneOff: "one-off" },
          size: { default: "default" },
          shape: { default: "default" },
          align: { center: "center" },
        },
        defaultVariants: {
          variant: "default",
          size: "default",
          shape: "default",
          align: "center",
        },
      });
    `,
  });
  const callerFile = new URL(
    "../src/components/__scanner-caller__.tsx",
    import.meta.url,
  ).pathname;
  const firstUsages = scanButtonAxisUsages({
    defaults,
    file: callerFile,
    source: `
      import { Button } from "@elizaos/ui/button";
      export function First() {
        return <><Button variant="shared" /><Button variant="oneOff" /></>;
      }
    `,
  });
  const secondUsages = scanButtonAxisUsages({
    defaults,
    file: callerFile.replace("caller", "second-caller"),
    source: `
      import { Button } from "@elizaos/ui/button";
      export function Second() { return <Button variant="shared" />; }
    `,
  });

  const underused = findUnderusedButtonAxes({
    definitions,
    usages: [...firstUsages, ...secondUsages],
  });
  assert.equal(
    underused.some(
      (entry) => entry.axis === "variant" && entry.value === "shared",
    ),
    false,
  );
  assert.deepEqual(
    underused
      .filter((entry) => entry.axis === "variant")
      .map(({ callerCount, value }) => ({ callerCount, value })),
    [
      { callerCount: 0, value: "default" },
      { callerCount: 1, value: "oneOff" },
    ],
  );
});

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

test("compliance inventory is deterministic and covers every governed rule", {
  timeout: 15_000,
}, () => {
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
  assert.equal(first.counts["button-axis-reuse"], 0);
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

test("baseline comparison rejects increases and permits reductions", {
  timeout: 15_000,
}, () => {
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

test("tight baseline comparison rejects stale allowances", {
  timeout: 15_000,
}, () => {
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
  assert.throws(
    () =>
      validateExceptions(
        {
          ...valid,
          exceptions: [{ ...valid.exceptions[0], rule: "button-axis-reuse" }],
        },
        now,
      ),
    /Invalid design-system exception/,
  );
});

test("markdown exposes counts and either source evidence or a zero-debt result", {
  timeout: 15_000,
}, () => {
  const report = buildComplianceReport({
    now: new Date("2026-08-24T00:00:00Z"),
  });
  const markdown = renderComplianceMarkdown(report);
  assert.match(markdown, /Design-system compliance report/);
  assert.match(markdown, /atomic-duplicate/);
  assert.match(markdown, /Registered adapters/);
  assert.match(markdown, /Scanned \d+ governed React source files/);
  if (report.findings.length > 0) assert.match(markdown, /packages\//);
  else assert.match(markdown, /### visual-override\n\nNone\./);
});
