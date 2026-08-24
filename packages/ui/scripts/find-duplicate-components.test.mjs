/**
 * Tests the repository-wide atomic component inventory against real source so
 * scope, ownership, and classification cannot silently narrow.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ATOMS,
  buildInventory,
  renderMarkdown,
} from "./find-duplicate-components.mjs";

test("the atomic inventory is deterministic and repository-wide", () => {
  const first = buildInventory();
  const second = buildInventory();

  assert.deepEqual(second, first);
  assert.equal(first.summary.atomicKinds, Object.keys(ATOMS).length);
  assert.ok(first.scannedFiles > 800);
  assert.deepEqual(first.scope, ["packages/**/*.tsx", "plugins/**/*.tsx"]);
});

test("the inventory identifies canonical ownership and parallel controls", () => {
  const report = buildInventory();
  const canonicalButtons = report.atoms.button.canonical.map(
    (entry) => entry.file,
  );
  const parallelButtons = report.atoms.button.candidates
    .filter((entry) => entry.classification === "parallel-primitive")
    .map((entry) => entry.name);

  assert.ok(
    canonicalButtons.includes("packages/ui/src/components/ui/button.tsx"),
  );
  assert.ok(parallelButtons.includes("BrandButton"));
  assert.ok(parallelButtons.includes("ViewBackButton"));
  assert.equal(report.atoms.card.rawHostUsage.length, 0);
  assert.ok(report.atoms.button.rawHostUsage.length > 0);
  assert.ok(
    report.atoms.button.rawHostUsage.some(
      (entry) => entry.classification === "mixed-canonical-and-raw",
    ),
  );
  assert.ok(
    report.atoms.button.rawHostUsage.some(
      (entry) => entry.classification === "plugin-raw-host",
    ),
  );
  assert.ok(
    report.atoms.checkbox.rawHostUsage.every((entry) =>
      entry.lines.every(
        (line) =>
          !report.atoms.input.rawHostUsage.some(
            (inputEntry) =>
              inputEntry.file === entry.file && inputEntry.lines.includes(line),
          ),
      ),
    ),
  );
  assert.equal(
    report.summary.reviewedParallelPrimitives,
    report.summary.parallelPrimitives,
  );
});

test("the markdown report exposes classifications and the molecular queue", () => {
  const markdown = renderMarkdown(buildInventory());

  assert.match(markdown, /Parallel primitives/);
  assert.match(markdown, /molecular-candidate/);
  assert.match(
    markdown,
    /packages\/ui\/src\/cloud-ui\/components\/brand\/brand-button\.tsx/,
  );
});
