/** Tests deterministic molecular grouping against the maintained repository. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertMolecularArtifactsCurrent,
  buildMolecularInventory,
  fileComposesContract,
  fileRendersContract,
  molecularClusterBinding,
  parseMolecularDecisionRegistry,
  parseMoleculeContractRegistry,
  renderMolecularMarkdown,
  serializeMolecularReport,
  validateMolecularDecisions,
  validateMoleculeContracts,
} from "./find-duplicate-molecular-components.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");

function exampleCluster(signature = "card:badge+button") {
  return {
    archetype: "card",
    atomicDependencies: ["badge", "button"],
    entries: [
      {
        atomicDependencies: ["badge", "button"],
        file: "packages/ui/src/alpha.tsx",
        name: "AlphaCard",
        renderedTags: ["Badge", "Button"],
      },
      {
        atomicDependencies: ["badge", "button"],
        file: "packages/ui/src/beta.tsx",
        name: "BetaCard",
        renderedTags: ["Badge", "Button"],
      },
    ],
    signature,
  };
}

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

test("molecule contract registry rejects under-proven owners", () => {
  assert.throws(
    () =>
      parseMoleculeContractRegistry({
        schemaVersion: 2,
        contracts: [{ id: "incomplete" }],
      }),
    /requires non-empty behavioralTest/,
  );
  assert.throws(
    () => parseMoleculeContractRegistry({ schemaVersion: 1, contracts: [] }),
    /requires schemaVersion 2 and contracts/,
  );
  assert.throws(
    () =>
      parseMoleculeContractRegistry({
        schemaVersion: 2,
        contracts: [
          {
            behavioralTest: "packages/ui/src/example.test.tsx",
            id: "example",
            minimumMaintainedReferences: 2,
            owner: "packages/ui/src/example.tsx",
            renderedStory: "packages/ui/src/example.stories.tsx",
            requiredAtomicDependencies: ["button"],
            requiredConsumerFiles: ["packages/ui/src/one.tsx"],
            requiredRenderedTags: ["Button"],
            responsibility: "Example.",
            symbol: "Example",
          },
        ],
      }),
    /requires at least two distinct maintained consumer files/,
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
    fs.writeFileSync(
      path.join(fixtureRoot, "story.tsx"),
      'import { CanonicalRow as Row } from "./barrel"; export default { component: Row };\n',
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "behavior.test.tsx"),
      'import { CanonicalRow } from "./wrong"; test("decoy", () => <CanonicalRow />);\n',
    );

    assert.equal(
      fileComposesContract(path.join(fixtureRoot, "consumer.tsx"), contract),
      true,
    );
    assert.equal(
      fileComposesContract(path.join(fixtureRoot, "decoy.tsx"), contract),
      false,
    );
    assert.equal(
      fileRendersContract(path.join(fixtureRoot, "story.tsx"), contract),
      true,
    );
    assert.throws(
      () =>
        validateMoleculeContracts(
          [
            {
              atomicDependencies: [],
              file: contract.owner,
              name: contract.symbol,
              renderedTags: ["div"],
            },
          ],
          [
            {
              ...contract,
              behavioralTest: `${relativeRoot}/behavior.test.tsx`,
              id: "canonical-row",
              minimumMaintainedReferences: 0,
              renderedStory: `${relativeRoot}/story.tsx`,
              requiredAtomicDependencies: [],
              requiredConsumerFiles: [],
              requiredRenderedTags: [],
            },
          ],
          {},
        ),
      /behavior\.test\.tsx does not render canonical CanonicalRow/,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true });
  }
});

test("molecular decisions bind exact members and semantic structure", () => {
  const cluster = exampleCluster();
  const binding = molecularClusterBinding(cluster);
  const decisions = {
    [cluster.signature]: {
      ...binding,
      disposition: "distinct-domain-compositions",
      rationale: "The domains own different state.",
    },
  };

  assert.doesNotThrow(() => validateMolecularDecisions([cluster], decisions));

  const drifted = {
    ...cluster,
    entries: [
      cluster.entries[0],
      {
        ...cluster.entries[1],
        file: "packages/ui/src/replacement.tsx",
      },
    ],
  };
  assert.throws(
    () => validateMolecularDecisions([drifted], decisions),
    /member IDs changed.*semantic fingerprint changed/,
  );

  const renderedStructureDrift = {
    ...cluster,
    entries: [
      cluster.entries[0],
      {
        ...cluster.entries[1],
        renderedTags: [...cluster.entries[1].renderedTags, "CardDescription"],
      },
    ],
  };
  assert.throws(
    () => validateMolecularDecisions([renderedStructureDrift], decisions),
    /semantic fingerprint changed/,
  );
});

test("molecular decision workflow states cannot pass the completion gate", () => {
  const unresolved = exampleCluster("card:badge+button");
  const canonicalize = exampleCluster("panel:button+input");
  const decisions = {
    [unresolved.signature]: {
      ...molecularClusterBinding(unresolved),
      disposition: "unresolved",
      rationale: "The lifecycle boundary has not been reviewed.",
    },
    [canonicalize.signature]: {
      ...molecularClusterBinding(canonicalize),
      canonicalContractId: "example-shell",
      disposition: "canonicalize",
      rationale: "Callers still need to migrate.",
    },
  };

  assert.throws(
    () =>
      validateMolecularDecisions(
        [unresolved, canonicalize],
        decisions,
        new Set(["example-shell"]),
      ),
    /non-final: card:badge\+button \(unresolved\), panel:button\+input \(canonicalize\)/,
  );
});

test("molecular decision registry rejects fingerprints that cannot bind", () => {
  assert.throws(
    () =>
      parseMolecularDecisionRegistry({
        schemaVersion: 2,
        decisions: {
          "card:badge+button": {
            disposition: "distinct-domain-compositions",
            memberComponentIds: ["packages/ui/src/alpha.tsx:AlphaCard"],
            rationale: "Different domains.",
            semanticFingerprint: "not-a-fingerprint",
          },
        },
      }),
    /at least two unique memberComponentIds/,
  );
});

test("molecular artifact checks compare formatted JSON by schema and data", () => {
  const report = {
    canonicalContracts: [],
    clusters: [],
    eligibleComponents: 0,
    scannedFiles: 0,
  };
  const artifacts = serializeMolecularReport(report);
  const differentlyFormattedJson = JSON.stringify(
    {
      scannedFiles: report.scannedFiles,
      eligibleComponents: report.eligibleComponents,
      clusters: report.clusters,
      canonicalContracts: report.canonicalContracts,
    },
    null,
    4,
  );

  assert.doesNotThrow(() =>
    assertMolecularArtifactsCurrent(report, {
      ...artifacts,
      json: differentlyFormattedJson,
    }),
  );
  assert.throws(
    () =>
      assertMolecularArtifactsCurrent(report, {
        ...artifacts,
        json: JSON.stringify({ ...report, scannedFiles: 1 }, null, 4),
      }),
    /artifacts are stale: json/,
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
