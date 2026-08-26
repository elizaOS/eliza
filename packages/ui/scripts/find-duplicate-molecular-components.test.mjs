/** Tests deterministic molecular grouping against the maintained repository. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildMolecularInventory,
  fileComposesContract,
  parseMoleculeContractRegistry,
  renderMolecularMarkdown,
  validateMolecularDecisions,
  validateMoleculeContracts,
} from "./find-duplicate-molecular-components.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");

test("molecular inventory is deterministic and requires meaningful signatures", () => {
  const first = buildMolecularInventory();
  const second = buildMolecularInventory();

  assert.deepEqual(second, first);
  assert.ok(first.summary.clusterCount > 0);
  assert.ok(first.clusters.every((cluster) => cluster.entries.length >= 2));
  assert.ok(
    first.clusters.every((cluster) => cluster.atomicDependencies.length >= 2),
  );
  assert.ok(first.clusters.every((cluster) => cluster.disposition));
  assert.ok(first.clusters.every((cluster) => cluster.rationale));
  assert.deepEqual(
    first.canonicalContracts.map((contract) => contract.id),
    [
      "auth-result-shell",
      "connection-capability-tile",
      "content-state",
      "settings-row",
      "action-list-row",
    ],
  );
  assert.ok(
    first.canonicalContracts.every(
      (contract) =>
        contract.maintainedReferences >= contract.minimumMaintainedReferences,
    ),
  );
});

test("canonical molecule contracts fail closed on owner drift", () => {
  const components = [
    {
      atomicDependencies: ["button"],
      file: "packages/ui/src/example.tsx",
      name: "ExampleRow",
      renderedTags: [],
    },
  ];
  const contracts = [
    {
      id: "example-row",
      minimumMaintainedReferences: 2,
      owner: "packages/ui/src/example.tsx",
      requiredAtomicDependencies: ["button", "badge"],
      requiredRenderedTags: ["Button", "Badge"],
      symbol: "ExampleRow",
    },
    {
      id: "missing-row",
      minimumMaintainedReferences: 0,
      owner: "packages/ui/src/missing.tsx",
      requiredAtomicDependencies: [],
      symbol: "MissingRow",
    },
  ];

  assert.throws(
    () =>
      validateMoleculeContracts(components, contracts, {
        "packages/ui/src/example.tsx:ExampleRow": 1,
      }),
    /missing rendered tags Button, Badge.*has 1 maintained references; expected at least 2.*missing owner packages\/ui\/src\/missing\.tsx:MissingRow/,
  );
});

test("canonical molecule contracts require named consumers to keep composing the owner", () => {
  assert.throws(
    () =>
      validateMoleculeContracts(
        [
          {
            atomicDependencies: ["button"],
            file: "packages/ui/src/example.tsx",
            name: "ExampleRow",
            renderedTags: ["Button"],
          },
        ],
        [
          {
            id: "example-row",
            minimumMaintainedReferences: 0,
            owner: "packages/ui/src/example.tsx",
            requiredAtomicDependencies: ["button"],
            requiredConsumerFiles: ["packages/ui/src/missing-consumer.tsx"],
            requiredRenderedTags: ["Button"],
            symbol: "ExampleRow",
          },
        ],
        {},
      ),
    /missing-consumer\.tsx no longer consumes canonical ExampleRow/,
  );
});

test("molecule contract registry rejects incomplete boundary data", () => {
  assert.throws(
    () =>
      parseMoleculeContractRegistry({
        schemaVersion: 1,
        contracts: [{ id: "incomplete" }],
      }),
    /requires non-empty owner/,
  );
  assert.throws(
    () => parseMoleculeContractRegistry({ schemaVersion: 2, contracts: [] }),
    /requires schemaVersion 1 and contracts/,
  );
});

test("consumer composition resolves the owner binding through aliases and barrels", () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(scriptDir, ".molecule-binding-"),
  );
  const relativeRoot = path
    .relative(repoRoot, fixtureRoot)
    .replaceAll(path.sep, "/");
  const contract = {
    owner: `${relativeRoot}/owner.tsx`,
    symbol: "CanonicalRow",
  };

  try {
    fs.writeFileSync(
      path.join(fixtureRoot, "owner.tsx"),
      "export function CanonicalRow() { return <div />; }\n",
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "barrel.ts"),
      'export { CanonicalRow } from "./owner";\n',
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "consumer.tsx"),
      'import { CanonicalRow as Row } from "./barrel"; export const Consumer = () => <Row />;\n',
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "decoy.tsx"),
      'import { CanonicalRow } from "./wrong"; export const Decoy = () => <CanonicalRow />;\n',
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "wrong.tsx"),
      "export function CanonicalRow() { return <span />; }\n",
    );

    assert.equal(
      fileComposesContract(path.join(fixtureRoot, "consumer.tsx"), contract),
      true,
    );
    assert.equal(
      fileComposesContract(path.join(fixtureRoot, "decoy.tsx"), contract),
      false,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true });
  }
});

test("molecular decisions reject candidate and duplicate states", () => {
  const clusters = [
    { signature: "card:badge+button" },
    { signature: "panel:button+input" },
  ];
  const decisions = {
    "card:badge+button": {
      disposition: "shared-shell-candidate",
      rationale: "Still needs review.",
    },
    "panel:button+input": {
      disposition: "duplicate-implementation",
      rationale: "Still needs consolidation.",
    },
  };

  assert.throws(
    () => validateMolecularDecisions(clusters, decisions),
    /non-final: card:badge\+button \(shared-shell-candidate\), panel:button\+input \(duplicate-implementation\)/,
  );
});

test("molecular report includes roles, dependencies, and source evidence", () => {
  const markdown = renderMolecularMarkdown(buildMolecularInventory());

  assert.match(markdown, /# Molecular component duplicate inventory/);
  assert.match(markdown, /Canonical molecule contracts/);
  assert.match(markdown, /ContentState/);
  assert.match(markdown, /Reviewed clusters/);
  assert.doesNotMatch(markdown, /-candidate\*\*/);
  assert.doesNotMatch(markdown, /Decision: \*\*duplicate-implementation\*\*/);
  assert.match(markdown, /shared-lifecycle-owner/);
  assert.match(markdown, /packages\//);
});
