/** Tests deterministic molecular grouping against the maintained repository. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMolecularInventory,
  renderMolecularMarkdown,
  validateMolecularDecisions,
} from "./find-duplicate-molecular-components.mjs";

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
  assert.match(markdown, /Reviewed clusters/);
  assert.doesNotMatch(markdown, /-candidate\*\*/);
  assert.doesNotMatch(markdown, /Decision: \*\*duplicate-implementation\*\*/);
  assert.match(markdown, /shared-lifecycle-owner/);
  assert.match(markdown, /packages\//);
});
