/**
 * Tests the repository-wide atomic component inventory against real source so
 * scope, ownership, and classification cannot silently narrow.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ATOMS,
  buildInventory,
  isMaintainedSource,
  renderMarkdown,
} from "./find-duplicate-components.mjs";

test("a generated declaration removed during a concurrent build is skipped", () => {
  assert.equal(
    isMaintainedSource(
      new URL("../../core/src/vanished-runtime-composition.d.ts", import.meta.url)
        .pathname,
    ),
    false,
  );
});

test("the atomic inventory is deterministic and repository-wide", () => {
  const first = buildInventory();
  const second = buildInventory();

  assert.deepEqual(second, first);
  assert.equal(first.summary.atomicKinds, Object.keys(ATOMS).length);
  assert.ok(first.scannedFiles > 800);
  assert.deepEqual(first.scope, ["packages/**/*.tsx", "plugins/**/*.tsx"]);
});

test("the inventory identifies canonical ownership without regressing wrappers", () => {
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
  assert.ok(!parallelButtons.includes("BrandButton"));
  assert.ok(!parallelButtons.includes("ViewBackButton"));
  assert.ok(
    report.atoms.button.candidates.some(
      (entry) =>
        entry.name === "BrandButton" &&
        entry.classification === "canonical-wrapper",
    ),
  );
  assert.ok(
    report.atoms.button.candidates.some(
      (entry) =>
        entry.name === "ViewBackButton" &&
        entry.classification === "canonical-wrapper",
    ),
  );
  assert.equal(report.atoms.card.rawHostUsage.length, 0);
  assert.ok(report.atoms.button.rawHostUsage.length > 0);
  assert.ok(
    report.atoms.button.rawHostUsage.every(
      (entry) => entry.classification !== "runtime-host-control",
    ),
  );
  assert.ok(
    report.atoms.button.rawHostUsage.every(
      (entry) =>
        entry.classification !== "mixed-canonical-and-raw" &&
        entry.classification !== "plugin-raw-host",
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
