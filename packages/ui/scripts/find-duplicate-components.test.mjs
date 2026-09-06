/**
 * Tests the repository-wide atomic component inventory against real source so
 * scope, ownership, and classification cannot silently narrow.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ATOMS,
  buildInventory,
  isMaintainedSource,
  listMaintainedSourceFiles,
  renderMarkdown,
} from "./find-duplicate-components.mjs";

test("a generated declaration removed during a concurrent build is skipped", () => {
  assert.equal(
    isMaintainedSource(
      new URL(
        "../../core/src/vanished-runtime-composition.d.ts",
        import.meta.url,
      ).pathname,
    ),
    false,
  );
});

test("local Eliza runtime artifacts are outside maintained source", () => {
  assert.equal(
    isMaintainedSource(
      new URL(
        "../../scenario-runner/.eliza/smthrs/session/generated-view.tsx",
        import.meta.url,
      ).pathname,
    ),
    false,
  );
});

test("Vite dependency cache is excluded from the maintained source boundary", () => {
  assert.equal(
    isMaintainedSource(
      fileURLToPath(
        new URL("../../app/.vite/deps/vendor.tsx", import.meta.url),
      ),
    ),
    false,
  );
});

test("generated mobile platform bundles and staging roots are outside maintained source", () => {
  assert.equal(
    isMaintainedSource(
      fileURLToPath(
        new URL(
          "../../app-core/platforms/android/app/src/main/assets/agent/Widget.tsx",
          import.meta.url,
        ),
      ),
    ),
    false,
  );
  assert.equal(
    isMaintainedSource(
      fileURLToPath(
        new URL(
          "../../agent/dist-mobile-ios/agent-bundle.tsx",
          import.meta.url,
        ),
      ),
    ),
    false,
  );
  assert.equal(
    isMaintainedSource(
      fileURLToPath(
        new URL(
          "../../app/ios/App/App/public/agent/Widget.tsx",
          import.meta.url,
        ),
      ),
    ),
    false,
  );
  assert.equal(
    isMaintainedSource(
      fileURLToPath(
        new URL(
          "../../app/android/app/src/main/assets/Widget.tsx",
          import.meta.url,
        ),
      ),
    ),
    false,
  );
  assert.equal(
    isMaintainedSource(
      fileURLToPath(
        new URL("../../app/electrobun/src/Widget.tsx", import.meta.url),
      ),
    ),
    false,
  );
  assert.equal(
    isMaintainedSource(
      fileURLToPath(
        new URL(
          "../../app-core/platforms/electrobun/src/Widget.tsx",
          import.meta.url,
        ),
      ),
    ),
    true,
  );
});

test("Android build output does not duplicate maintained React source", () => {
  const source = fileURLToPath(
    new URL("../src/components/ui/button.tsx", import.meta.url),
  );
  const outputRoot = fileURLToPath(
    new URL("../../agent/dist-mobile/", import.meta.url),
  );
  fs.mkdirSync(outputRoot, { recursive: true });
  const output = fs.mkdtempSync(path.join(outputRoot, "inventory-probe-"));
  try {
    const bundledSource = path.join(output, "button.tsx");
    fs.copyFileSync(source, bundledSource);
    const files = listMaintainedSourceFiles();
    assert.ok(
      files.includes(source),
      "the maintained source must remain visible",
    );
    assert.equal(files.includes(bundledSource), false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
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
  const allCandidates = Object.values(report.atoms).flatMap(
    (group) => group.candidates,
  );
  const componentIds = new Set(
    report.components.map((entry) => `${entry.file}:${entry.name}`),
  );
  const removedComponentIds = [
    "packages/ui/src/cloud-ui/components/brand/brand-button.tsx:BrandButton",
    "packages/ui/src/cloud-ui/components/brand/brand-card.tsx:BrandCard",
    "packages/ui/src/cloud-ui/components/brand/lock-on-button.tsx:LockOnButton",
    "packages/ui/src/components/apps/extensions/surface.tsx:SurfaceBadge",
    "packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:CloudTextInput",
  ];

  assert.ok(
    canonicalButtons.includes("packages/ui/src/components/ui/button.tsx"),
  );
  for (const id of removedComponentIds) {
    assert.equal(componentIds.has(id), false, `${id} must stay deleted`);
  }

  const retainedAdapters = [
    {
      id: "packages/ui/src/components/RedactedBadge.tsx:RedactedBadge",
      canonicalOwner: "packages/ui/src/components/ui/badge.tsx",
    },
    {
      id: "packages/ui/src/components/transcripts/SpeakerNameAttributionBadge.tsx:SpeakerNameAttributionBadge",
      canonicalOwner: "packages/ui/src/components/ui/status-badge.tsx",
    },
    {
      id: "packages/ui/src/components/shared/ViewHeader.tsx:ViewBackButton",
      canonicalOwner: "packages/ui/src/components/ui/button.tsx",
    },
    {
      id: "packages/ui/src/components/local-inference/DownloadProgress.tsx:DownloadProgress",
      canonicalOwner: "packages/ui/src/components/ui/progress.tsx",
    },
  ];
  for (const expected of retainedAdapters) {
    const candidate = allCandidates.find(
      (entry) => `${entry.file}:${entry.name}` === expected.id,
    );
    assert.equal(
      candidate?.decision?.disposition,
      "intentional-specialization",
      `${expected.id} must remain a reviewed adapter`,
    );
    assert.equal(candidate?.decision?.canonicalOwner, expected.canonicalOwner);
  }
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
  assert.doesNotMatch(markdown, /brand\/brand-button\.tsx/);
  assert.doesNotMatch(markdown, /brand\/brand-card\.tsx/);
  assert.doesNotMatch(markdown, /brand\/lock-on-button\.tsx/);
  assert.match(markdown, /intentional-specialization/);
  assert.match(
    markdown,
    /packages\/ui\/src\/components\/shared\/ViewHeader\.tsx/,
  );
});
