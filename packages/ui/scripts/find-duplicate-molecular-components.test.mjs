/** Tests deterministic molecular grouping against the maintained repository. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMolecularInventory,
  renderMolecularMarkdown,
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

test("molecular report includes roles, dependencies, and source evidence", () => {
  const markdown = renderMolecularMarkdown(buildMolecularInventory());

  assert.match(markdown, /# Molecular component duplicate inventory/);
  assert.match(markdown, /Candidate clusters/);
  assert.match(markdown, /duplicate-implementation/);
  assert.match(markdown, /packages\//);
});
