/** Verifies deterministic, fail-closed design-system compliance accounting. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeTokenRoleClasses,
  applyExceptions,
  assertCanonicalRecipeContractsSeen,
  assertRegisteredAdaptersUsed,
  auditCanonicalTokenRoles,
  buildCardVariantMigrationInventory,
  buildComplianceReport,
  collectAtomicDuplicateFindings,
  compareToBaseline,
  compareToTightBaseline,
  extractButtonAxisDefinitions,
  extractCardVariantDefinitions,
  findUnderusedButtonAxes,
  findUnderusedCardVariants,
  indexPaintedCssClasses,
  RULES,
  renderComplianceMarkdown,
  resolvesToCanonical,
  scanButtonAxisUsages,
  scanCardVariantUsages,
  scanSourceText,
  validateAdapterRegistry,
  validateExceptions,
  validatePublicCardVariantCompatibility,
} from "./check-design-system.mjs";

test("atomic consolidation ledger survives relabel, deletion, and reintroduction", () => {
  const componentId = "packages/ui/src/example.tsx:ExampleButton";
  const canonicalOwner = "packages/ui/src/components/ui/button.tsx";
  const candidate = {
    classification: "canonical-wrapper",
    decision: {
      canonicalOwner,
      disposition: "intentional-specialization",
    },
    file: "packages/ui/src/example.tsx",
    line: 12,
    name: "ExampleButton",
  };
  const inventory = {
    atoms: { button: { candidates: [candidate] } },
    components: [{ file: candidate.file, name: candidate.name }],
  };
  const unresolved = {
    schemaVersion: 1,
    entries: [{ componentId, canonicalOwner, status: "unresolved" }],
  };
  const ownerExists = {
    fileExists: (file) => file === canonicalOwner,
  };

  assert.deepEqual(
    collectAtomicDuplicateFindings(inventory, unresolved, ownerExists),
    [
      {
        detail: `Consolidate with ${canonicalOwner}.`,
        file: candidate.file,
        line: 12,
        rule: "atomic-duplicate",
        symbol: candidate.name,
      },
    ],
  );
  assert.equal(
    collectAtomicDuplicateFindings(
      { atoms: { button: { candidates: [] } }, components: [] },
      unresolved,
      ownerExists,
    )[0]?.file,
    candidate.file,
  );

  assert.throws(
    () =>
      collectAtomicDuplicateFindings(
        inventory,
        {
          schemaVersion: 1,
          entries: [
            { componentId, canonicalOwner, status: "resolved-deleted" },
          ],
        },
        ownerExists,
      ),
    /reintroduced after deletion/,
  );

  assert.throws(
    () =>
      collectAtomicDuplicateFindings(
        { atoms: { button: { candidates: [] } }, components: [] },
        {
          schemaVersion: 1,
          entries: [
            { componentId, canonicalOwner, status: "resolved-deleted" },
          ],
        },
        { fileExists: () => false },
      ),
    /lost canonical owner/,
  );
});

test("named CSS cannot hide paint on a canonical atom", () => {
  const paintedCssClasses = indexPaintedCssClasses([
    {
      file: "packages/ui/src/styles/scanner.css",
      source:
        ".one-off-painted-surface { background: red; border-radius: 12px; }",
    },
  ]);
  const findings = scanSourceText({
    file: new URL(
      "../src/components/__scanner-css-paint__.tsx",
      import.meta.url,
    ).pathname,
    paintedCssClasses,
    source: `
      import { Card } from "@elizaos/ui";
      export function HiddenPaint() {
        return <Card className="one-off-painted-surface layout-only">Painted</Card>;
      }
    `,
  });
  assert.deepEqual(
    findings.filter((finding) => finding.rule === "visual-override"),
    [
      {
        detail:
          "Canonical visual state is hidden in painted CSS class one-off-painted-surface; move that paint into the atom's typed contract.",
        file: "packages/ui/src/components/__scanner-css-paint__.tsx",
        line: 4,
        rule: "visual-override",
        symbol: "Card",
      },
    ],
  );
});

test("stateful CSS selectors index only the painted selector subject", () => {
  const paintedCssClasses = indexPaintedCssClasses([
    {
      file: "packages/ui/src/styles/scanner-state.css",
      source: `
        .hoverPaint:hover { background: red; }
        .statePaint[data-state="open"] { border-color: red; }
        .ancestorPaint .descendantPaint:hover { box-shadow: 0 0 1px red; }
        :where(.wherePaint) { background: red; }
        :is(.isPaint) { color: red; }
        :global(.globalPaint) { outline-color: red; }
        .functionalAncestor :where(.functionalChild) { background: red; }
      `,
    },
  ]);
  const findings = scanSourceText({
    file: new URL(
      "../src/components/__scanner-css-state-paint__.tsx",
      import.meta.url,
    ).pathname,
    paintedCssClasses,
    source: `
      import { Card } from "@elizaos/ui";
      export function StatefulPaint() {
        return <>
          <Card className="hoverPaint">Hover</Card>
          <Card className="statePaint" data-state="open">Open</Card>
          <Card className="ancestorPaint">Ancestor only</Card>
          <Card className="descendantPaint">Painted descendant</Card>
          <Card className="wherePaint">Where subject</Card>
          <Card className="isPaint">Is subject</Card>
          <Card className="globalPaint">Global subject</Card>
          <Card className="functionalAncestor">Functional ancestor</Card>
          <Card className="functionalChild">Functional child</Card>
        </>;
      }
    `,
  });

  assert.deepEqual(
    findings
      .filter((finding) => finding.rule === "visual-override")
      .map(({ line, symbol }) => ({ line, symbol })),
    [
      { line: 5, symbol: "Card" },
      { line: 6, symbol: "Card" },
      { line: 8, symbol: "Card" },
      { line: 9, symbol: "Card" },
      { line: 10, symbol: "Card" },
      { line: 11, symbol: "Card" },
      { line: 13, symbol: "Card" },
    ],
  );
});

test("helper-returned JSX spreads cannot hide canonical visual overrides", () => {
  const findings = scanSourceText({
    file: new URL(
      "../src/components/__scanner-helper-visual-spread__.tsx",
      import.meta.url,
    ).pathname,
    source: `
      import { Card } from "@elizaos/ui/card";
      import { importedProps } from "./opaque-card-props";
      function paintedClassProps() {
        return { className: "bg-surface" };
      }
      function paintedStyleProps() {
        return { style: { borderColor: "white" } };
      }
      const helperObject = {
        props() {
          return { className: "border-border" };
        },
      };
      const nestedHelpers = {
        nested: {
          props() {
            return { className: "bg-card" };
          },
        },
      };
      export function HelperVisualSpread() {
        return <>
          <Card {...paintedClassProps()} />
          <Card {...paintedStyleProps()} />
          <Card {...helperObject.props()} />
          <Card {...nestedHelpers.nested.props()} />
          <Card {...importedProps} />
        </>;
      }
    `,
  });

  assert.deepEqual(
    findings
      .filter((finding) => finding.rule === "visual-override")
      .map(({ line, symbol }) => ({ line, symbol })),
    [
      { line: 24, symbol: "Card" },
      { line: 25, symbol: "Card" },
      { line: 26, symbol: "Card" },
      { line: 27, symbol: "Card" },
      { line: 28, symbol: "Card" },
    ],
  );
});

test("maintained React factory files inspect canonical atom props", () => {
  const paintedCssClasses = indexPaintedCssClasses([
    {
      file: "packages/ui/src/styles/scanner-factory.css",
      source: ".factoryPaint { background: red; }",
    },
  ]);
  const findings = scanSourceText({
    file: new URL(
      "../src/components/__scanner-react-factory__.ts",
      import.meta.url,
    ).pathname,
    paintedCssClasses,
    source: `
      import React from "react";
      import { Card } from "@elizaos/ui/card";
      export function FactoryCard() {
        return React.createElement(Card, { className: "factoryPaint" });
      }
      export function BrowserElement() {
        return document.createElement(Card, { className: "factoryPaint" });
      }
    `,
  });
  const javascriptFindings = scanSourceText({
    file: new URL(
      "../src/components/__scanner-react-factory__.js",
      import.meta.url,
    ).pathname,
    paintedCssClasses,
    source: `
      import { createElement } from "react";
      import { Card } from "@elizaos/ui/card";
      export function FactoryCard() {
        return createElement(Card, { className: "factoryPaint" });
      }
    `,
  });

  assert.deepEqual(
    [...findings, ...javascriptFindings].filter(
      (finding) => finding.rule === "visual-override",
    ),
    [
      {
        detail:
          "Canonical visual state is hidden in painted CSS class factoryPaint; move that paint into the atom's typed contract.",
        file: "packages/ui/src/components/__scanner-react-factory__.ts",
        line: 5,
        rule: "visual-override",
        symbol: "Card",
      },
      {
        detail:
          "Canonical visual state is hidden in painted CSS class factoryPaint; move that paint into the atom's typed contract.",
        file: "packages/ui/src/components/__scanner-react-factory__.js",
        line: 5,
        rule: "visual-override",
        symbol: "Card",
      },
    ],
  );
});

test("namespace atoms and aliased React factories cannot bypass visual checks", () => {
  const findings = scanSourceText({
    file: new URL(
      "../src/components/__scanner-react-aliases__.tsx",
      import.meta.url,
    ).pathname,
    source: `
      import React from "react";
      import * as UI from "@elizaos/ui";
      import * as kit from "@elizaos/ui";
      import { Card } from "@elizaos/ui/card";
      const localKit = { Card };
      const renamedKit = { Surface: Card };
      const Surface = Card;
      const { createElement: h } = React;
      const bracketFactory = React["createElement"];
      export function AliasCards() {
        return <>
          <UI.Card className="bg-card" />
          <kit.Card className="border-border" />
          <localKit.Card className="bg-card" />
          <renamedKit.Surface className="border-border" />
          <Surface className="bg-card" />
          {h(UI.Card, { className: "bg-card" })}
          {bracketFactory(kit.Card, { style: { borderColor: "white" } })}
          {React.createElement(localKit.Card, { className: "bg-card" })}
          {React.createElement(renamedKit.Surface, { className: "border-border" })}
          {React.createElement(Surface, { className: "bg-card" })}
        </>;
      }
    `,
  });

  assert.deepEqual(
    findings
      .filter((finding) => finding.rule === "visual-override")
      .map(({ line, symbol }) => ({ line, symbol })),
    [
      { line: 13, symbol: "Card" },
      { line: 14, symbol: "Card" },
      { line: 15, symbol: "Card" },
      { line: 16, symbol: "Card" },
      { line: 17, symbol: "Card" },
      { line: 18, symbol: "Card" },
      { line: 19, symbol: "Card" },
      { line: 20, symbol: "Card" },
      { line: 21, symbol: "Card" },
      { line: 22, symbol: "Card" },
    ],
  );
});

test("Card visualStyle rejects raw literals but preserves token and runtime values", () => {
  const findings = scanSourceText({
    file: new URL(
      "../src/components/__scanner-card-visual-style__.tsx",
      import.meta.url,
    ).pathname,
    source: `
      import { Card } from "@elizaos/ui/card";
      const runtimeColor = getRuntimeColor();
      function localPaint() { return "rgb(255 255 255)"; }
      function localToken() { return "var(--bg-muted)"; }
      export function CardVisualStyle() {
        return <>
          <Card visualStyle={{ backgroundColor: "#fff" }} />
          <Card visualStyle={{ borderRadius: 12 }} />
          <Card visualStyle={{ backgroundColor: "var(--bg-muted)" }} />
          <Card visualStyle={{ backgroundColor: runtimeColor }} />
          <Card visualStyle={{ backgroundColor: localPaint() }} />
          <Card visualStyle={{ backgroundColor: "rgb(" + "255 255 255)" }} />
          <Card visualStyle={{ borderRadius: \`\${12}px\` }} />
          <Card visualStyle={{ backgroundColor: localToken() }} />
        </>;
      }
    `,
  });

  assert.deepEqual(
    findings
      .filter((finding) => finding.rule === "visual-override")
      .map(({ line, symbol }) => ({ line, symbol })),
    [
      { line: 8, symbol: "Card" },
      { line: 9, symbol: "Card" },
      { line: 12, symbol: "Card" },
      { line: 13, symbol: "Card" },
      { line: 14, symbol: "Card" },
    ],
  );
});

test("Card tokenStyle accepts only canonical CSS variable keys", () => {
  const findings = scanSourceText({
    file: new URL(
      "../src/components/__scanner-card-token-style__.tsx",
      import.meta.url,
    ).pathname,
    source: `
      import { Card } from "@elizaos/ui/card";
      import { runtimeToken } from "./runtime-token";
      const localPaint = "rgb(255 0 0)";
      export function CardTokenStyle() {
        return <>
          <Card tokenStyle={{ "--bg": "var(--runtime-bg)" }} visualStyle={{ background: "var(--bg)" }} />
          <Card tokenStyle={{ "--escape": "rgb(255 0 0)" }} visualStyle={{ background: "var(--escape)" }} />
          <Card tokenStyle={{ "--bg": "rgb(255 0 0)" }} />
          <Card tokenStyle={{ "--bg": runtimeToken }} />
          <Card tokenStyle={{ "--bg": localPaint }} />
        </>;
      }
    `,
  });

  assert.deepEqual(
    findings
      .filter((finding) => finding.rule === "visual-override")
      .map(({ line, symbol }) => ({ line, symbol })),
    [
      { line: 8, symbol: "Card" },
      { line: 9, symbol: "Card" },
      { line: 11, symbol: "Card" },
    ],
  );
});

test("opaque function-parameter spreads fail closed on canonical atoms", () => {
  const findings = scanSourceText({
    file: new URL(
      "../src/components/__scanner-forwarded-spread__.tsx",
      import.meta.url,
    ).pathname,
    source: `
      import { Card } from "@elizaos/ui/card";
      export function ForwardedCard(props) {
        return <Card {...props} />;
      }
    `,
  });

  assert.deepEqual(
    findings
      .filter((finding) => finding.rule === "visual-override")
      .map(({ line, symbol }) => ({ line, symbol })),
    [{ line: 4, symbol: "Card" }],
  );
});

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

test("raw flat and outlined card recipes are independently order-normalized", () => {
  const file = new URL(
    "../src/components/__scanner-card-recipe__.tsx",
    import.meta.url,
  ).pathname;
  const findings = scanSourceText({
    file,
    source: `
      export function RawCards() {
        return <>
          <section className="space-y-4 p-4 bg-card rounded-sm">Duplicate</section>
          <section className="rounded-sm border border-border bg-card p-4">Distinct outlined surface</section>
          <Card className="bg-background/85 border-border/70">Repainted report panel</Card>
          <aside className="py-2 border-border bg-surface px-3 border rounded-sm">Raw compact inset</aside>
        </>;
      }
    `,
  });

  const duplicates = findings.filter(
    (finding) => finding.rule === "raw-card-recipe",
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.symbol, "section");
  const outlinedDuplicates = findings.filter(
    (finding) => finding.rule === "raw-outlined-card-recipe",
  );
  assert.equal(outlinedDuplicates.length, 1);
  assert.equal(outlinedDuplicates[0]?.symbol, "section");
  assert.equal(
    findings.filter((finding) => finding.rule === "card-report-panel-override")
      .length,
    1,
  );
  assert.equal(
    findings.filter((finding) => finding.rule === "raw-inset-card-recipe")
      .length,
    1,
  );
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
  assert.deepEqual(
    analyzeTokenRoleClasses({
      className: "bg-launcher-icon-sheen",
      role: "surface",
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

test("Card variants require reuse instead of storing molecule-local paint", () => {
  const cardFile = new URL(
    "../src/components/ui/__scanner-card__.tsx",
    import.meta.url,
  ).pathname;
  const { definitions, defaults } = extractCardVariantDefinitions({
    file: cardFile,
    source: `
      const cardVariants = cva("base", {
        variants: {
          variant: { default: "default", shared: "shared", oneOff: "one-off" },
          stack: { none: "" },
          flow: { none: "" },
          gap: { none: "" },
          padding: { none: "" },
          tone: { default: "" },
          surface: { default: "" },
          border: { default: "" },
          radius: { default: "" },
          shadow: { default: "" },
        },
        defaultVariants: {
          variant: "default",
          stack: "none",
          flow: "none",
          gap: "none",
          padding: "none",
          tone: "default",
          surface: "default",
          border: "default",
          radius: "default",
          shadow: "default",
        },
      });
    `,
  });
  const callerFile = new URL(
    "../src/components/__scanner-card-caller__.tsx",
    import.meta.url,
  ).pathname;
  const usages = scanCardVariantUsages({
    defaults,
    file: callerFile,
    source: `
      import { Card, cardVariants } from "@elizaos/ui/card";
      const appearance = active ? "shared" : "oneOff";
      function sharedAppearance() { return "shared"; }
      export function Fixture() {
        return <><Card variant={appearance} /><Card />{cardVariants({ variant: sharedAppearance() })}</>;
      }
    `,
  });

  const underusedVariants = findUnderusedCardVariants({
    definitions,
    usages,
  }).filter((entry) => entry.axis === "variant");
  assert.deepEqual(
    underusedVariants.map(({ callerCount, value }) => ({ callerCount, value })),
    [
      { callerCount: 1, value: "default" },
      { callerCount: 1, value: "shared" },
      { callerCount: 1, value: "oneOff" },
    ],
  );

  const migration = buildCardVariantMigrationInventory(underusedVariants);
  assert.deepEqual(migration.byDomain, {
    "ui/components": ["default", "shared", "oneOff"],
  });
  assert.deepEqual(migration.entries[2], {
    callerCount: 1,
    callers: [
      {
        file: "packages/ui/src/components/__scanner-card-caller__.tsx",
        line: 6,
      },
    ],
    domains: ["ui/components"],
    file: "packages/ui/src/components/ui/__scanner-card__.tsx",
    line: 4,
    recipe: "one-off",
    suggestedAxes: {},
    suggestedOwner: "ui/components molecule",
    value: "oneOff",
  });
});

test("published Card compatibility variants require exact public API and recipe evidence", () => {
  const now = new Date("2026-08-27T00:00:00Z");
  const entry = {
    id: "legacy-public-compatibility",
    value: "legacy",
    file: "packages/ui/src/components/ui/card.tsx",
    packageExports: [".", "./card"],
    publicSymbols: ["Card", "CardProps", "cardVariants"],
    publicBarrels: [
      {
        file: "packages/ui/src/index.ts",
        reexport: "./components/primitives/index",
      },
      {
        file: "packages/ui/src/components/primitives/index.ts",
        reexport: "../ui/card",
      },
      {
        file: "packages/ui/src/browser.ts",
        reexport: "./components/ui/card.tsx",
      },
    ],
    recipe: "legacy-recipe",
    reason: "Preserves a published downstream variant.",
    reviewBy: "2027-02-27",
  };
  const cardVariants = [
    {
      axis: "variant",
      callerCount: 0,
      callers: [],
      file: entry.file,
      line: 1,
      recipe: entry.recipe,
      value: entry.value,
    },
  ];
  const packageDocument = {
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
      "./card": {
        types: "./dist/components/ui/card.d.ts",
        import: "./dist/components/ui/card.js",
        default: "./dist/components/ui/card.js",
      },
    },
  };
  const cardSource = `
    type VariantProps<T> = T;
    const Card = () => null;
    const cardVariants = () => "";
    export interface CardProps extends VariantProps<typeof cardVariants> {}
    export { Card, cardVariants };
  `;
  const publicBarrelSources = {
    "packages/ui/src/index.ts":
      'export * from "./components/primitives/index";',
    "packages/ui/src/components/primitives/index.ts":
      'export * from "../ui/card";',
    "packages/ui/src/browser.ts": 'export * from "./components/ui/card.tsx";',
  };

  assert.deepEqual(
    validatePublicCardVariantCompatibility({
      cardSource,
      cardVariants,
      document: { schemaVersion: 1, variants: [entry] },
      now,
      publicBarrelSources,
      packageDocument,
    }).map(({ callerCount, value }) => ({ callerCount, value })),
    [{ callerCount: 0, value: "legacy" }],
  );
  assert.throws(
    () =>
      validatePublicCardVariantCompatibility({
        cardSource,
        cardVariants,
        document: {
          schemaVersion: 1,
          variants: [{ ...entry, recipe: "drifted" }],
        },
        now,
        publicBarrelSources,
        packageDocument,
      }),
    /does not match its canonical recipe/,
  );
  assert.throws(
    () =>
      validatePublicCardVariantCompatibility({
        cardSource,
        cardVariants: [{ ...cardVariants[0], callerCount: 2 }],
        document: { schemaVersion: 1, variants: [entry] },
        now,
        publicBarrelSources,
        packageDocument,
      }),
    /is no longer underused/,
  );
  assert.throws(
    () =>
      validatePublicCardVariantCompatibility({
        cardSource,
        cardVariants,
        document: {
          schemaVersion: 1,
          variants: [{ ...entry, publicSymbols: ["Card"] }],
        },
        now,
        publicBarrelSources,
        packageDocument,
      }),
    /Invalid public Card variant compatibility/,
  );
  assert.throws(
    () =>
      validatePublicCardVariantCompatibility({
        cardSource: cardSource.replace(
          "extends VariantProps<typeof cardVariants>",
          "",
        ),
        cardVariants,
        document: { schemaVersion: 1, variants: [entry] },
        now,
        publicBarrelSources,
        packageDocument,
      }),
    /requires CardProps to derive VariantProps<typeof cardVariants>/,
  );
  assert.throws(
    () =>
      validatePublicCardVariantCompatibility({
        cardSource,
        cardVariants,
        document: { schemaVersion: 1, variants: [entry] },
        now,
        publicBarrelSources: {
          ...publicBarrelSources,
          "packages/ui/src/browser.ts": "export const browser = true;",
        },
        packageDocument,
      }),
    /is missing public barrel packages\/ui\/src\/browser\.ts/,
  );
  assert.throws(
    () =>
      validatePublicCardVariantCompatibility({
        cardSource,
        cardVariants,
        document: { schemaVersion: 1, variants: [entry] },
        now,
        publicBarrelSources,
        packageDocument: {
          exports: { ".": packageDocument.exports["."] },
        },
      }),
    /requires the canonical \.\/card package export/,
  );
  assert.throws(
    () =>
      validatePublicCardVariantCompatibility({
        cardSource,
        cardVariants,
        document: { schemaVersion: 1, variants: [entry] },
        now,
        publicBarrelSources,
        packageDocument: {
          exports: { "./card": packageDocument.exports["./card"] },
        },
      }),
    /requires the canonical root package export/,
  );
  for (const duplicate of [
    { ...entry, value: "other-public-compatibility" },
    { ...entry, id: "other-public-compatibility" },
  ]) {
    assert.throws(
      () =>
        validatePublicCardVariantCompatibility({
          cardSource,
          cardVariants,
          document: { schemaVersion: 1, variants: [entry, duplicate] },
          now,
          publicBarrelSources,
          packageDocument,
        }),
      /Invalid public Card variant compatibility/,
    );
  }
  assert.throws(
    () =>
      validatePublicCardVariantCompatibility({
        cardSource,
        cardVariants,
        document: {
          schemaVersion: 1,
          variants: [{ ...entry, reviewBy: "2026-08-26" }],
        },
        now,
        publicBarrelSources,
        packageDocument,
      }),
    /Stale public Card variant compatibility/,
  );
});

test("Card axis inventory follows helper-returned JSX spreads", () => {
  const file = new URL(
    "../src/components/__scanner-card-spread__.tsx",
    import.meta.url,
  ).pathname;
  const usages = scanCardVariantUsages({
    defaults: {
      border: "default",
      flow: "none",
      gap: "none",
      padding: "none",
      radius: "default",
      shadow: "default",
      stack: "none",
      surface: "default",
      tone: "default",
      variant: "default",
    },
    file,
    source: `
      import { Card } from "@elizaos/ui/card";
      function cardProps() {
        return { variant: "shared", surface: "card", radius: "large" };
      }
      export function SpreadCard() { return <Card {...cardProps()} />; }
    `,
  });

  assert.deepEqual(
    usages
      .filter((usage) => ["variant", "surface", "radius"].includes(usage.axis))
      .map(({ axis, owner, value }) => ({ axis, owner, value })),
    [
      { axis: "variant", owner: "SpreadCard", value: "shared" },
      { axis: "surface", owner: "SpreadCard", value: "card" },
      { axis: "radius", owner: "SpreadCard", value: "large" },
    ],
  );
});

test("Card reuse credit excludes stories and private dead owners", () => {
  const defaults = {
    border: "default",
    flow: "none",
    gap: "none",
    padding: "none",
    radius: "default",
    shadow: "default",
    stack: "none",
    surface: "default",
    tone: "default",
    variant: "default",
  };
  const storyFile = new URL(
    "../src/components/__scanner-card__.stories.tsx",
    import.meta.url,
  ).pathname;
  const storySource = `
      import { Card } from "@elizaos/ui/card";
      export function StoryOnly() { return <Card variant="shared" />; }
    `;
  const sourceFile = new URL(
    "../src/components/__scanner-card-live-owner__.tsx",
    import.meta.url,
  ).pathname;
  const source = `
      import { Card } from "@elizaos/ui/card";
      function DeadOwner() { return <Card variant="shared" />; }
      function VoidOnly() { return <Card variant="shared" />; }
      function LiveHelper() { return <Card variant="shared" />; }
      export function PublicOwner() { void VoidOnly; return <LiveHelper />; }
    `;
  const storyUsages = scanCardVariantUsages({
    defaults,
    file: storyFile,
    source: storySource,
  });
  const sourceUsages = scanCardVariantUsages({
    defaults,
    file: sourceFile,
    source,
  });
  const integratedUsages = [];
  scanSourceText({
    cardDefaults: defaults,
    cardUsages: integratedUsages,
    file: storyFile,
    source: storySource,
  });
  scanSourceText({
    cardDefaults: defaults,
    cardUsages: integratedUsages,
    file: sourceFile,
    source,
  });

  assert.deepEqual(storyUsages, []);
  assert.deepEqual(
    sourceUsages
      .filter((usage) => usage.axis === "variant")
      .map(({ owner, value }) => ({ owner, value })),
    [{ owner: "LiveHelper", value: "shared" }],
  );
  assert.deepEqual(
    integratedUsages
      .filter((usage) => usage.axis === "variant")
      .map(({ owner, value }) => ({ owner, value })),
    [{ owner: "LiveHelper", value: "shared" }],
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

test("canonical atom className permits caller layout and typography but rejects paint", () => {
  const file = new URL("../src/__scanner-fixture__.tsx", import.meta.url)
    .pathname;
  const findings = scanSourceText({
    file,
    source: `
      import { Button } from "@elizaos/ui";
      export function Fixture() {
        return (<>
          <Button className="p-4 h-10 gap-2 text-center text-sm">Layout</Button>
          <Button className="bg-surface text-txt">Paint</Button>
        </>);
      }
    `,
  });

  const overrides = findings.filter(
    (finding) => finding.rule === "visual-override",
  );
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].line, 6);
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
  const vaultEmpty = first.publicCardVariantCompatibility.find(
    (entry) => entry.id === "vault-empty-public-compatibility",
  );
  assert.deepEqual(vaultEmpty, {
    callerCount: 0,
    file: "packages/ui/src/components/ui/card.tsx",
    id: "vault-empty-public-compatibility",
    packageExports: [".", "./card"],
    publicBarrels: [
      {
        file: "packages/ui/src/index.ts",
        reexport: "./components/primitives/index",
      },
      {
        file: "packages/ui/src/components/primitives/index.ts",
        reexport: "../ui/card",
      },
      {
        file: "packages/ui/src/browser.ts",
        reexport: "./components/ui/card.tsx",
      },
    ],
    publicSymbols: ["Card", "CardProps", "cardVariants"],
    reason:
      "The published @elizaos/ui/card VariantProps and cardVariants helper exposed vaultEmpty before the maintained Vault callers moved to layout-owned empty states. Preserve downstream source and runtime compatibility while internal usage remains intentionally zero.",
    recipe:
      "border border-dashed border-border/50 bg-card/20 p-3 text-center text-xs text-muted",
    reviewBy: "2027-02-27",
    value: "vaultEmpty",
  });
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
  assert.deepEqual(
    scanCardVariantUsages({
      defaults: { variant: "default" },
      file: new URL(
        "../src/cloud/analytics/_components/chart.tsx",
        import.meta.url,
      ).pathname,
      source: `
        import { Card } from "../../../cloud-ui";
        export function Chart() { return <Card variant="reportPanel" />; }
      `,
    }).map(({ value }) => value),
    ["reportPanel"],
  );
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
  assert.throws(
    () =>
      validateExceptions(
        {
          ...valid,
          exceptions: [{ ...valid.exceptions[0], rule: "card-variant-reuse" }],
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
