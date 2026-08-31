/**
 * Exercises the typed design graph against synthetic invalid dependencies and
 * the maintained repository so the Wave 0 inventory cannot pass vacuously.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertDesignContractReport,
  buildDesignContractReport,
  renderDesignContractMarkdown,
} from "./check-design-contract-graph.ts";
import {
  buildDesignContractGraph,
  inventoryDesignTokens,
  parseMoleculeContracts,
  resolveCanonicalAtomImport,
  validateDeclaredAtomicDependencies,
  validateDeclaredMoleculeConsumers,
  validateDesignDependencyGraph,
  validateHigherOrderOwners,
} from "./design-contract-inventory.ts";
import {
  compareDesignDebt,
  type DesignDebtLedger,
  type DesignNode,
  parseDesignDebtLedger,
  parseHigherOrderDesignRegistry,
  validateDesignNodes,
} from "./design-contract-schema.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");

const token: DesignNode = {
  id: "token:test",
  layer: "token",
  owner: { kind: "stylesheet", file: "packages/ui/src/styles/test.css" },
  responsibility: "Synthetic token owner.",
  dependsOn: [],
  grants: ["paint.surface"],
  provenance: "declared",
  tokenFamilies: ["color"],
  sourceDigest: "a".repeat(64),
  declaredTokenCount: 1,
};

test("token inventory derives aliases and fails closed on broken graphs", () => {
  const valid = inventoryDesignTokens(`
    :root { --surface: #fff; --card: var(--surface); }
    .dark { --surface: #111; }
  `);
  assert.equal(valid.records.length, 2);
  assert.deepEqual(valid.missingAliases, []);
  assert.deepEqual(valid.cycles, []);
  assert.equal(
    valid.records.find((record) => record.name === "card")?.family,
    "surface",
  );

  const invalid = inventoryDesignTokens(`
    :root {
      --surface: var(--missing);
      --cycle-a: var(--cycle-b);
      --cycle-b: var(--cycle-a);
    }
  `);
  assert.deepEqual(invalid.missingAliases, [
    { token: "surface", alias: "missing" },
  ]);
  assert.ok(invalid.cycles.length > 0);
});

const atom: DesignNode = {
  id: "atom:test",
  layer: "atom",
  owner: {
    kind: "export",
    file: "packages/ui/src/components/ui/test.tsx",
    symbol: "Test",
  },
  responsibility: "Synthetic atom owner.",
  dependsOn: [token.id],
  grants: ["layout.local"],
  provenance: "derived-atomic-inventory",
  atomicKind: "test",
  semanticHosts: ["div"],
};

test("dependency validation rejects missing and upward owners", () => {
  const invalidMolecule: DesignNode = {
    id: "molecule:test",
    layer: "molecule",
    owner: {
      kind: "export",
      file: "packages/ui/src/components/test.tsx",
      symbol: "TestMolecule",
    },
    responsibility: "Synthetic molecule owner.",
    dependsOn: ["page-shell:missing"],
    grants: ["layout.container"],
    provenance: "derived-molecule-contract",
    requiredRenderedTags: [],
  };
  const findings = validateDesignDependencyGraph([
    token,
    atom,
    invalidMolecule,
  ]);
  assert.ok(
    findings.some((finding) => finding.rule === "dependency/missing-node"),
  );

  const upwardAtom: DesignNode = {
    ...atom,
    dependsOn: [invalidMolecule.id],
  };
  assert.ok(
    validateDesignDependencyGraph([token, upwardAtom, invalidMolecule]).some(
      (finding) => finding.rule === "dependency/not-downward",
    ),
  );
  assert.deepEqual(
    validateDesignDependencyGraph([invalidMolecule, atom, token]),
    findings,
  );
});

test("schema validation rejects duplicate owners and malformed debt", () => {
  assert.throws(
    () => validateDesignNodes([atom, atom]),
    /Duplicate design node/,
  );
  assert.throws(
    () => parseDesignDebtLedger({ schemaVersion: 1, entries: [{}] }),
    /fingerprint/,
  );
  assert.throws(
    () =>
      parseDesignDebtLedger({
        schemaVersion: 1,
        entries: [
          {
            fingerprint: "a".repeat(64),
            matchCount: 1,
            rule: "synthetic/date",
            owner: "synthetic",
            reason: "Invalid calendar date fixture.",
            addedOn: "2026-02-31",
            reviewBy: "2026-08-30",
          },
        ],
      }),
    /addedOn must use YYYY-MM-DD/,
  );
  assert.throws(
    () =>
      parseHigherOrderDesignRegistry({
        schemaVersion: 1,
        organisms: [{}],
        pageShells: [],
      }),
    /Organism declaration/,
  );
  assert.throws(
    () =>
      parseHigherOrderDesignRegistry({
        schemaVersion: 1,
        organisms: [],
        pageShells: [
          {
            id: "page-shell:test",
            owner: {
              kind: "export",
              file: "packages/ui/src/layouts/test.tsx",
              symbol: "TestPageFrame",
            },
            responsibility: "Synthetic page frame.",
            dependsOn: [],
            grants: ["layout.viewport"],
            supportedLayoutKinds: ["native"],
            supportedTopologies: ["framed"],
          },
        ],
      }),
    /invalid layout kind native/,
  );
});

test("exact debt comparison rejects new, stale, and expired entries", () => {
  const finding = validateDesignDependencyGraph([
    token,
    { ...atom, dependsOn: ["token:missing"] },
  ])[0];
  const empty: DesignDebtLedger = { schemaVersion: 1, entries: [] };
  assert.deepEqual(
    compareDesignDebt([finding], empty, new Date("2026-08-25T00:00:00Z"))
      .newFindings,
    [finding],
  );

  const ledger: DesignDebtLedger = {
    schemaVersion: 1,
    entries: [
      {
        fingerprint: finding.fingerprint,
        matchCount: 1,
        rule: finding.rule,
        owner: finding.owner,
        reason: "Synthetic migration debt.",
        addedOn: "2026-08-01",
        reviewBy: "2026-08-24",
      },
    ],
  };
  const comparison = compareDesignDebt(
    [],
    ledger,
    new Date("2026-08-25T00:00:00Z"),
  );
  assert.equal(comparison.staleDebt.length, 1);
  assert.equal(comparison.expiredDebt.length, 1);

  const excess = compareDesignDebt(
    [finding, finding],
    ledger,
    new Date("2026-08-23T00:00:00Z"),
  );
  assert.equal(excess.newFindings.length, 1);
  assert.equal(excess.staleDebt.length, 0);

  const mismatchedMetadata = compareDesignDebt(
    [finding],
    {
      schemaVersion: 1,
      entries: [{ ...ledger.entries[0], rule: "synthetic/wrong-rule" }],
    },
    new Date("2026-08-23T00:00:00Z"),
  );
  assert.equal(mismatchedMetadata.newFindings.length, 1);
  assert.equal(mismatchedMetadata.staleDebt.length, 1);
});

test("atomic composition requires the canonical source module", () => {
  const atomOwnersByExport = new Map([
    [
      "Button",
      { kind: "button", file: "packages/ui/src/components/ui/button.tsx" },
    ],
  ]);
  const importingFile = path.join(
    repoRoot,
    "packages/ui/src/components/settings/settings-layout.tsx",
  );
  assert.equal(
    resolveCanonicalAtomImport({
      binding: { imported: "Button", origin: "../ui/button" },
      importingFile,
      atomOwnersByExport,
    }),
    "button",
  );
  assert.equal(
    resolveCanonicalAtomImport({
      binding: { imported: "Button", origin: "../shared/ActionListRow" },
      importingFile,
      atomOwnersByExport,
    }),
    null,
  );
  assert.equal(
    resolveCanonicalAtomImport({
      binding: {
        imported: "Button",
        origin: "@elizaos/ui/definitely-not-a-real-module",
      },
      importingFile,
      atomOwnersByExport,
    }),
    null,
  );
});

test("declared composition atoms reject drift in both directions", () => {
  const findings = validateDeclaredAtomicDependencies({
    nodeId: "molecule:test",
    owner: "packages/ui/src/components/test.tsx:TestMolecule",
    declaredAtomicDependencies: ["button", "spinner"],
    sourceAtomicDependencies: ["button", "card"],
  });

  assert.deepEqual(
    findings.map((finding) => finding.rule),
    [
      "composition/missing-atomic-dependency",
      "composition/undeclared-atomic-dependency",
    ],
  );
  assert.match(findings[0].detail, /spinner/);
  assert.match(findings[1].detail, /card/);
  assert.deepEqual(
    validateDeclaredAtomicDependencies({
      nodeId: "molecule:test",
      owner: "packages/ui/src/components/test.tsx:TestMolecule",
      declaredAtomicDependencies: ["button", "card"],
      sourceAtomicDependencies: ["button", "card"],
    }),
    [],
  );
});

test("declared molecule consumers enforce required files and reference floors", () => {
  const findings = validateDeclaredMoleculeConsumers({
    nodeId: "molecule:fixture",
    owner: "packages/ui/src/fixture.tsx:Fixture",
    requiredConsumerFiles: [
      "packages/ui/src/consumer-a.tsx",
      "packages/ui/src/consumer-b.tsx",
    ],
    minimumMaintainedReferences: 2,
    sourceConsumerFiles: ["packages/ui/src/consumer-a.tsx"],
  });

  assert.deepEqual(
    findings.map((finding) => finding.rule),
    [
      "composition/insufficient-maintained-references",
      "composition/missing-required-consumer",
    ],
  );
  assert.deepEqual(
    validateDeclaredMoleculeConsumers({
      nodeId: "molecule:fixture",
      owner: "packages/ui/src/fixture.tsx:Fixture",
      requiredConsumerFiles: ["packages/ui/src/consumer-a.tsx"],
      minimumMaintainedReferences: 1,
      sourceConsumerFiles: ["packages/ui/src/consumer-a.tsx"],
    }),
    [],
  );
});

test("molecule contract boundary requires representative migration evidence", () => {
  const contract = {
    behavioralTest: "packages/ui/src/components/example.test.tsx",
    id: "example",
    minimumMaintainedReferences: 2,
    owner: "packages/ui/src/components/example.tsx",
    renderedStory: "packages/ui/src/components/example.stories.tsx",
    requiredAtomicDependencies: ["button"],
    requiredConsumerFiles: [
      "packages/ui/src/components/consumer-a.tsx",
      "packages/ui/src/components/consumer-b.tsx",
    ],
    requiredRenderedTags: ["Button"],
    responsibility: "Owns the example composition.",
    symbol: "Example",
  };

  assert.deepEqual(
    parseMoleculeContracts({ schemaVersion: 2, contracts: [contract] }),
    [contract],
  );
  assert.throws(
    () =>
      parseMoleculeContracts({
        schemaVersion: 1,
        contracts: [contract],
      }),
    /schemaVersion 2/,
  );
  assert.throws(
    () =>
      parseMoleculeContracts({
        schemaVersion: 2,
        contracts: [{ ...contract, behavioralTest: undefined }],
      }),
    /behavioralTest must be a string/,
  );
  assert.throws(
    () =>
      parseMoleculeContracts({
        schemaVersion: 2,
        contracts: [
          {
            ...contract,
            requiredConsumerFiles: [
              "packages/ui/src/components/consumer-a.tsx",
            ],
          },
        ],
      }),
    /at least two distinct maintained consumer files/,
  );
});

test("compound exports in an atomic owner module stay in the atom layer", async () => {
  const report = await buildDesignContractReport({
    debtMode: "normal",
  });
  const cardParts = report.graph.observations.discoveredComponents.filter(
    (component) => component.file === "packages/ui/src/components/ui/card.tsx",
  );
  assert.ok(cardParts.length > 1);
  assert.ok(cardParts.every((component) => component.inferredLayer === "atom"));
});

test("higher-order contracts must name maintained exported owners", () => {
  const registry = parseHigherOrderDesignRegistry({
    schemaVersion: 1,
    organisms: [],
    pageShells: [
      {
        id: "page-shell:test",
        owner: {
          kind: "export",
          file: "packages/ui/src/layouts/test.tsx",
          symbol: "TestPageFrame",
        },
        responsibility: "Synthetic page frame.",
        dependsOn: [],
        grants: ["layout.viewport"],
        supportedLayoutKinds: ["content"],
        supportedTopologies: ["framed"],
      },
    ],
  });
  assert.equal(
    validateHigherOrderOwners(registry.pageShells, new Set()).length,
    1,
  );
  assert.equal(
    validateHigherOrderOwners(
      registry.pageShells,
      new Set(["packages/ui/src/layouts/test.tsx:TestPageFrame"]),
    ).length,
    0,
  );
});

test("maintained source produces a deterministic closed graph", async () => {
  const first = await buildDesignContractGraph();
  assert.equal(first.findings.length, 0);
  assert.ok(first.nodes.every((node) => node.responsibility.trim().length > 0));
  assert.ok(
    first.edges.every((edge) =>
      first.nodes.some((node) => node.id === edge.to),
    ),
  );
  assert.ok(first.observations.paintedRawHosts.length > 0);

  const legacyModuleUrl = new URL(
    "./find-duplicate-components.mjs",
    import.meta.url,
  );
  const legacyModule: unknown = await import(legacyModuleUrl.href);
  assert.ok(
    typeof legacyModule === "object" &&
      legacyModule !== null &&
      "listMaintainedSourceFiles" in legacyModule &&
      typeof legacyModule.listMaintainedSourceFiles === "function",
  );
  const legacyFiles: unknown = legacyModule.listMaintainedSourceFiles();
  assert.ok(Array.isArray(legacyFiles));
  assert.deepEqual(
    first.sourceFiles,
    legacyFiles
      .map((file) =>
        path.relative(repoRoot, String(file)).replaceAll(path.sep, "/"),
      )
      .sort(),
  );
});

test("declared molecule nodes retain the complete live atom closure", async () => {
  const graph = await buildDesignContractGraph();
  const expectedDependencies = new Map<string, readonly string[]>([
    ["molecule:action-list-row", ["atom:button", "atom:card"]],
    ["molecule:auth-result-shell", ["atom:card"]],
    ["molecule:connection-capability-tile", ["atom:card"]],
    ["molecule:content-state", ["atom:card", "atom:spinner"]],
    ["molecule:settings-row", ["atom:button", "atom:card"]],
  ]);

  for (const [nodeId, expected] of expectedDependencies) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    assert.ok(node, `missing declared molecule ${nodeId}`);
    assert.deepEqual(node.dependsOn, expected, nodeId);
  }
});

test("declared higher-order nodes retain their discovered live atom closure", async () => {
  const graph = await buildDesignContractGraph();
  const higherOrderNodes = graph.nodes.filter(
    (node) => node.layer === "organism" || node.layer === "page-shell",
  );

  for (const node of higherOrderNodes) {
    assert.equal(node.owner.kind, "export", node.id);
    if (node.owner.kind !== "export") continue;
    const component = graph.observations.discoveredComponents.find(
      (candidate) =>
        candidate.file === node.owner.file &&
        candidate.symbol === node.owner.symbol,
    );
    assert.ok(component, `missing discovered owner for ${node.id}`);
    assert.deepEqual(
      node.dependsOn.filter((dependency) => dependency.startsWith("atom:")),
      component.transitiveAtoms.map((atom) => `atom:${atom}`),
      node.id,
    );
  }

  const vaultWorkspace = graph.nodes.find(
    (node) => node.id === "organism:vault-workspace",
  );
  assert.ok(vaultWorkspace, "missing organism:vault-workspace");
  assert.deepEqual(vaultWorkspace.owner, {
    kind: "export",
    file: "packages/ui/src/components/settings/SecretsManagerSection.tsx",
    symbol: "VaultWorkspace",
  });
  const vaultOwner = vaultWorkspace.owner;
  assert.equal(vaultOwner.kind, "export");
  if (vaultOwner.kind !== "export") {
    assert.fail("organism:vault-workspace owner must be an exported component");
  }
  const vaultComponent = graph.observations.discoveredComponents.find(
    (candidate) =>
      candidate.file === vaultOwner.file &&
      candidate.symbol === vaultOwner.symbol,
  );
  assert.ok(vaultComponent, "missing live VaultWorkspace component");
  assert.deepEqual(vaultComponent.transitiveAtoms, [
    "alert",
    "badge",
    "banner",
    "button",
    "card",
    "checkbox",
    "dialog",
    "input",
    "radioGroup",
    "select",
    "separator",
    "table",
    "tabs",
  ]);
  assert.deepEqual(
    vaultWorkspace.dependsOn,
    vaultComponent.transitiveAtoms.map((atom) => `atom:${atom}`),
  );
});

test("reusable owners inherit raw capability findings from private helpers", async () => {
  const graph = await buildDesignContractGraph();
  assert.ok(
    graph.findings.every(
      (finding) =>
        finding.rule !== "composition/raw-capability-owner" ||
        finding.detail.includes("claims") ||
        finding.detail.includes("reaches helper"),
    ),
  );
});

test("report renders the real graph and passes an empty exact ledger", async () => {
  const report = await buildDesignContractReport({
    now: new Date("2026-08-25T00:00:00Z"),
    ledger: { schemaVersion: 1, entries: [] },
    debtMode: "tight",
  });
  assert.equal(report.debtComparison.newFindings.length, 0);
  assert.match(renderDesignContractMarkdown(report), /Findings\n\nNone\./);
  assert.doesNotThrow(() => assertDesignContractReport(report));
  const staleEntry = {
    fingerprint: "a".repeat(64),
    matchCount: 1,
    rule: "synthetic/stale",
    owner: "packages/ui/src/synthetic.tsx:Synthetic",
    reason: "Synthetic reduction proof.",
    addedOn: "2026-08-01",
    reviewBy: "2026-08-30",
  };
  const normalReport = {
    ...report,
    debtMode: "normal" as const,
    debt: { schemaVersion: 1 as const, entries: [staleEntry] },
    debtComparison: { ...report.debtComparison, staleDebt: [staleEntry] },
  };
  assert.doesNotThrow(() => assertDesignContractReport(normalReport));
  assert.throws(
    () => assertDesignContractReport({ ...normalReport, debtMode: "tight" }),
    /stale debt/,
  );
});
