/**
 * Tests for the pull request evidence checker. The fixtures model the PR body
 * instead of shelling out so the gate's parsing rules stay deterministic and
 * cheap to run in PR workflows.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  boundRowBlock,
  evaluatePrEvidence,
  extractEvidenceRows,
  findRetiredRepoEvidenceFiles,
  hasArtifactReference,
  hasNaWithReason,
  hasOcrEvidenceReference,
  hasVisualArtifactReference,
  isChecked,
  isRowSatisfied,
  isRowSatisfiedForContext,
  parseLabels,
  REQUIRED_EVIDENCE_ROWS,
  requiresSurfaceArtifacts,
  requiresSurfaceArtifactsFromFiles,
  SURFACE_ARTIFACT_ROW_IDS,
} from "./check-pr-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(HERE, "..", ".github", "pull_request_template.md");
const RETIRED_REPO_EVIDENCE_PATH = [
  ".github",
  ["issue", "evidence"].join("-"),
].join("/");

function buildBody(overrides = {}) {
  const defaults = {
    "before-screenshots":
      "- [ ] Before screenshots `N/A - backend-only change, no UI surface`.",
    "after-screenshots":
      "- [ ] After screenshots `N/A - backend-only change, no UI surface`.",
    "walkthrough-video":
      "- [x] A video walkthrough: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000",
    "backend-logs":
      "- [ ] Backend logs: [backend.txt](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001)",
    "frontend-logs": "- [ ] Frontend logs `N/A - no frontend change`.",
    "llm-trajectory":
      "- [ ] Real-LLM trajectory: [report](https://example.com/report.json)",
    "domain-artifacts":
      "- [ ] Domain artifacts: OCR report https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000007",
  };
  const merged = { ...defaults, ...overrides };
  return REQUIRED_EVIDENCE_ROWS.map(
    ({ id }) => `<!-- evidence-row:${id} -->\n${merged[id] ?? ""}`,
  ).join("\n\n");
}

describe("check-pr-evidence parser", () => {
  it("passes when every evidence row has an artifact or N/A reason", () => {
    const { ok, findings } = evaluatePrEvidence(buildBody());
    assert.equal(ok, true);
    assert.ok(findings.every((finding) => finding.status === "ok"));
  });

  it("fails on a single blank row", () => {
    const { ok, findings } = evaluatePrEvidence(
      buildBody({
        "backend-logs":
          "- [ ] Backend logs show the real code path firing end to end, or are marked `N/A - <reason>`.",
      }),
    );
    assert.equal(ok, false);
    assert.equal(
      findings.find((finding) => finding.id === "backend-logs").status,
      "blank",
    );
    assert.equal(
      findings.filter((finding) => finding.status === "ok").length,
      REQUIRED_EVIDENCE_ROWS.length - 1,
    );
  });

  it("fails when a row is checked without an artifact or N/A reason", () => {
    const { ok, findings } = evaluatePrEvidence(
      buildBody({
        "backend-logs": "- [x] Backend logs attached.",
      }),
    );
    assert.equal(ok, false);
    assert.equal(
      findings.find((finding) => finding.id === "backend-logs").status,
      "blank",
    );
  });

  it("fails when every required row is checked without artifacts or N/A reasons", () => {
    const checkedRows = Object.fromEntries(
      REQUIRED_EVIDENCE_ROWS.map(({ id, label }) => [
        id,
        `- [x] ${label} attached.`,
      ]),
    );
    const { ok, findings } = evaluatePrEvidence(buildBody(checkedRows));
    assert.equal(ok, false);
    assert.ok(findings.every((finding) => finding.status === "blank"));
  });

  it("passes when every row is marked `N/A - <reason>`", () => {
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - not applicable to this change\`.`,
    ).join("\n\n");
    assert.equal(evaluatePrEvidence(body).ok, true);
  });

  it("fails UI-labeled PRs when screenshot/video rows are only N/A", () => {
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - not applicable to this change\`.`,
    ).join("\n\n");
    const { ok, findings } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      labels: "ui",
    });
    assert.equal(ok, false);
    for (const id of SURFACE_ARTIFACT_ROW_IDS) {
      assert.equal(
        findings.find((finding) => finding.id === id).status,
        "artifact-required",
      );
    }
    assert.equal(
      findings.find((finding) => finding.id === "ocr-review").status,
      "ocr-required",
    );
  });

  it("passes UI-labeled PRs when screenshot/video rows and OCR proof have concrete artifacts", () => {
    const { ok, findings } = evaluatePrEvidence(
      buildBody({
        "before-screenshots":
          "- [ ] Before screenshots: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000002",
        "after-screenshots":
          "- [ ] After screenshots: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000003",
        "walkthrough-video":
          "- [ ] Walkthrough video: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000004",
        "domain-artifacts":
          "- [ ] OCR text readout: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000008",
      }),
      REQUIRED_EVIDENCE_ROWS,
      { labels: "frontend" },
    );
    assert.equal(ok, true);
    assert.ok(findings.every((finding) => finding.status === "ok"));
  });

  it("fails UI-labeled PRs when screenshot/video artifacts omit OCR proof", () => {
    const { ok, findings } = evaluatePrEvidence(
      buildBody({
        "before-screenshots":
          "- [ ] Before screenshots: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000002",
        "after-screenshots":
          "- [ ] After screenshots: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000003",
        "walkthrough-video":
          "- [ ] Walkthrough video: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000004",
        "domain-artifacts":
          "- [ ] Domain artifacts `N/A - no domain artifacts produced`.",
      }),
      REQUIRED_EVIDENCE_ROWS,
      { labels: "ui" },
    );
    assert.equal(ok, false);
    assert.equal(
      findings.find((finding) => finding.id === "ocr-review").status,
      "ocr-required",
    );
  });

  it("fails on a bare `N/A` with no reason", () => {
    const { ok, findings } = evaluatePrEvidence(
      buildBody({ "backend-logs": "- [ ] Backend logs N/A" }),
    );
    assert.equal(ok, false);
    assert.equal(
      findings.find((finding) => finding.id === "backend-logs").status,
      "blank",
    );
  });

  it("reports a required row as missing when its marker is absent", () => {
    const body = REQUIRED_EVIDENCE_ROWS.slice(1)
      .map(
        ({ id }) =>
          `<!-- evidence-row:${id} -->\n- [ ] N/A - covered elsewhere`,
      )
      .join("\n\n");
    const { ok, findings } = evaluatePrEvidence(body);
    assert.equal(ok, false);
    assert.equal(
      findings.find((finding) => finding.id === "before-screenshots").status,
      "missing",
    );
  });

  it("treats an empty body as all-missing", () => {
    const { ok, findings } = evaluatePrEvidence("");
    assert.equal(ok, false);
    assert.ok(findings.every((finding) => finding.status === "missing"));
  });
});

describe("check-pr-evidence row primitives", () => {
  it("accepts N/A separators with a real reason", () => {
    assert.equal(hasNaWithReason("N/A - backend-only, no UI"), true);
    assert.equal(hasNaWithReason("N/A: nothing to show here"), true);
    assert.equal(hasNaWithReason("N/A \u2014 no domain artifacts"), true);
    assert.equal(hasNaWithReason("NA - agent change only"), true);
  });

  it("rejects bare or placeholder N/A reasons", () => {
    assert.equal(hasNaWithReason("N/A"), false);
    assert.equal(hasNaWithReason("N/A -"), false);
    assert.equal(hasNaWithReason("N/A - "), false);
    assert.equal(hasNaWithReason("N/A - <reason>."), false);
  });

  it("detects links and URLs", () => {
    assert.equal(hasArtifactReference("[report](https://x/y.json)"), true);
    assert.equal(
      hasArtifactReference("see https://github.com/o/r/assets/1"),
      true,
    );
    assert.equal(
      hasArtifactReference(
        "see https://user-images.githubusercontent.com/1/a.jpg",
      ),
      true,
    );
    assert.equal(hasArtifactReference("just words, no artifact"), false);
  });

  it("detects linked OCR evidence without accepting keyword-only prose", () => {
    const rows = new Map([
      [
        "domain-artifacts",
        "- [ ] OCR report: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000009",
      ],
    ]);
    assert.equal(hasOcrEvidenceReference(rows), true);
    assert.equal(
      hasOcrEvidenceReference(
        new Map([["domain-artifacts", "- [ ] OCR report was reviewed"]]),
      ),
      false,
    );
  });

  it("rejects retired repo-local evidence paths", () => {
    assert.equal(
      hasArtifactReference(
        `committed under ${RETIRED_REPO_EVIDENCE_PATH}/13676-a.png`,
      ),
      false,
    );
    assert.equal(
      hasArtifactReference(
        `[proof](${RETIRED_REPO_EVIDENCE_PATH}/13676-a.png)`,
      ),
      false,
    );
    const { ok, findings } = evaluatePrEvidence(
      buildBody({
        "backend-logs": `- [ ] Backend logs: ${RETIRED_REPO_EVIDENCE_PATH}/13676-backend.txt`,
      }),
    );
    assert.equal(ok, false);
    assert.equal(
      findings.find((finding) => finding.id === "backend-logs").status,
      "blank",
    );
  });

  it("rejects changed files under the retired repo-local evidence path", () => {
    assert.deepEqual(
      findRetiredRepoEvidenceFiles([
        "packages/app/test-results/report.json",
        `${RETIRED_REPO_EVIDENCE_PATH}/13676-backend.txt`,
        String.raw`.github\issue-evidence\13676-windows-path.txt`,
      ]),
      [
        `${RETIRED_REPO_EVIDENCE_PATH}/13676-backend.txt`,
        String.raw`.github\issue-evidence\13676-windows-path.txt`,
      ],
    );
  });

  it("accepts non-repo evidence directories in the diff", () => {
    assert.deepEqual(
      findRetiredRepoEvidenceFiles([
        "packages/evidence/src/schema.ts",
        "packages/app/test-results/issue-evidence/report.json",
      ]),
      [],
    );
  });

  it("detects checked checkboxes without treating them as evidence", () => {
    assert.equal(isChecked("- [x] done"), true);
    assert.equal(isChecked("- [X] done"), true);
    assert.equal(isChecked("- [ ] not done"), false);
    assert.equal(isRowSatisfied("- [x] done"), false);
  });

  it("requires real media on visual rows — page links do not count", () => {
    // The gaming vector: linking the PR itself or its /checks tab.
    assert.equal(
      hasVisualArtifactReference(
        "- [ ] Before: https://github.com/elizaOS/eliza/pull/15178/checks",
      ),
      false,
    );
    assert.equal(
      hasVisualArtifactReference(
        "- [ ] After: https://github.com/elizaOS/eliza/pull/15178",
      ),
      false,
    );
    // Real media forms all count.
    assert.equal(
      hasVisualArtifactReference(
        "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
      ),
      true,
    );
    assert.equal(
      hasVisualArtifactReference("![after](https://example.com/x/after)"),
      true,
    );
    assert.equal(
      hasVisualArtifactReference(
        '<img src="https://example.com/shot" width="400">',
      ),
      true,
    );
    assert.equal(
      hasVisualArtifactReference("see https://example.com/walkthrough.mp4"),
      true,
    );
  });

  it("fails a UI-labeled PR whose visual rows link only to the PR/checks page", () => {
    const { ok, findings } = evaluatePrEvidence(
      buildBody({
        "before-screenshots":
          "- [ ] Before screenshots: https://github.com/elizaOS/eliza/pull/15178",
        "after-screenshots":
          "- [ ] After screenshots: https://github.com/elizaOS/eliza/pull/15178/checks",
        "walkthrough-video":
          "- [ ] Walkthrough video: https://github.com/elizaOS/eliza/pull/15178/checks",
      }),
      REQUIRED_EVIDENCE_ROWS,
      { labels: "ui" },
    );
    assert.equal(ok, false);
    for (const id of SURFACE_ARTIFACT_ROW_IDS) {
      assert.equal(
        findings.find((finding) => finding.id === id).status,
        "artifact-required",
      );
    }
  });

  it("detects rendered-UI source files in the diff", () => {
    assert.equal(
      requiresSurfaceArtifactsFromFiles(["packages/ui/src/components/Foo.tsx"]),
      true,
    );
    assert.equal(
      requiresSurfaceArtifactsFromFiles(["packages/app/src/views/Home.css"]),
      true,
    );
    assert.equal(
      requiresSurfaceArtifactsFromFiles([
        String.raw`apps\app\src\Panel.tsx`,
      ]),
      true,
    );
    // Tests, stories, and server code render nothing a user sees.
    assert.equal(
      requiresSurfaceArtifactsFromFiles([
        "packages/ui/src/components/Foo.test.tsx",
        "packages/ui/src/components/Foo.stories.tsx",
        "packages/app-core/src/services/thing.ts",
        "packages/app/README.md",
      ]),
      false,
    );
  });

  it("forces surface artifacts from a UI diff even without labels", () => {
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - not applicable to this change\`.`,
    ).join("\n\n");
    const { ok, findings } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles: ["packages/ui/src/components/NotificationRow.tsx"],
    });
    assert.equal(ok, false);
    for (const id of SURFACE_ARTIFACT_ROW_IDS) {
      assert.equal(
        findings.find((finding) => finding.id === id).status,
        "artifact-required",
      );
    }
    assert.equal(
      findings.find((finding) => finding.id === "ocr-review").status,
      "ocr-required",
    );
  });

  it("allows N/A before-screenshots when the whole UI surface is newly added", () => {
    const media = (id, n) =>
      `- [x] ![${id}](https://github.com/user-attachments/assets/00000000-0000-0000-0000-00000000000${n})`;
    const body = buildBody({
      "before-screenshots":
        "- [ ] Before screenshots `N/A - the settings section is new in this PR; no prior surface existed`.",
      "after-screenshots": media("after", 2),
      "walkthrough-video":
        "- [x] https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000003",
      "domain-artifacts":
        "- [ ] OCR text readout: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000008",
    });
    const changedFiles = [
      "packages/ui/src/components/settings/NewSection.tsx",
      "packages/ui/src/components/settings/new-section.test.ts",
    ];
    // Whole surface added → before may be N/A-with-reason.
    const allNew = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles,
      addedFiles: changedFiles,
    });
    assert.equal(allNew.ok, true);
    // Same body but the surface file was MODIFIED → before still needs media.
    const modified = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles,
      addedFiles: [],
    });
    assert.equal(modified.ok, false);
    assert.equal(
      modified.findings.find((f) => f.id === "before-screenshots").status,
      "artifact-required",
    );
    // A bare N/A with no reason never qualifies, even for a new surface.
    const bare = evaluatePrEvidence(
      buildBody({
        "before-screenshots": "- [ ] Before screenshots N/A",
        "after-screenshots": media("after", 2),
        "walkthrough-video":
          "- [x] https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000003",
        "domain-artifacts":
          "- [ ] OCR text readout: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000008",
      }),
      REQUIRED_EVIDENCE_ROWS,
      { changedFiles, addedFiles: changedFiles },
    );
    assert.equal(bare.ok, false);
  });

  it("path detection overrides the coarse ui label when files are known", () => {
    // The auto-labeler applies `ui` to any packages/ui path; a non-visual .ts
    // change must not be forced to attach screenshots.
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - non-visual .ts module change\`.`,
    ).join("\n\n");
    const { ok } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      labels: "ui",
      changedFiles: ["packages/ui/src/navigation/index.ts"],
    });
    assert.equal(ok, true);
    // But a rendered-UI file still forces artifacts regardless of labels.
    const forced = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      labels: "",
      changedFiles: ["packages/ui/src/navigation/index.ts", "packages/ui/src/components/Foo.tsx"],
    });
    assert.equal(forced.ok, false);
  });

  it("normalizes labels and detects surface labels", () => {
    assert.deepEqual(parseLabels("bug, UI\nNative"), ["bug", "ui", "native"]);
    assert.equal(requiresSurfaceArtifacts("testing,backend"), false);
    assert.equal(requiresSurfaceArtifacts(["ci", "Frontend"]), true);
  });

  it("requires N/A-reason or artifact to satisfy a row", () => {
    assert.equal(isRowSatisfied("- [ ] `N/A - not applicable`"), true);
    assert.equal(isRowSatisfied("- [ ] [proof](https://e/x.png)"), true);
    assert.equal(
      isRowSatisfied(
        "- [ ] Before screenshots are attached, or marked `N/A - <reason>`.",
      ),
      false,
    );
  });

  it("requires artifacts when artifact-required mode is enabled", () => {
    assert.equal(
      isRowSatisfiedForContext("- [ ] `N/A - no UI`", {
        artifactRequired: true,
      }),
      false,
    );
    assert.equal(
      isRowSatisfiedForContext(
        "- [ ] https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000005",
        {
          artifactRequired: true,
        },
      ),
      true,
    );
  });
});

describe("check-pr-evidence marker extraction", () => {
  it("captures the checkbox line plus indented continuation lines", () => {
    const body = [
      "<!-- evidence-row:backend-logs -->",
      "- [ ] Backend logs show the real code path firing end to end,",
      "      or are marked `N/A - no backend path in this change`.",
      "",
      "<!-- evidence-row:frontend-logs -->",
      "- [ ] Frontend logs: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000006",
    ].join("\n");
    const rows = extractEvidenceRows(body);
    assert.ok(rows.get("backend-logs").includes("N/A - no backend path"));
    assert.ok(rows.get("frontend-logs").includes("user-attachments/assets"));
  });

  it("bounds the last row so trailing links do not bleed in", () => {
    const body = [
      "<!-- evidence-row:domain-artifacts -->",
      "- [ ] Domain artifacts are attached where applicable, or marked `N/A - <reason>`.",
      "",
      "# Evidence Details",
      "",
      "See [the runner](https://example.com/report.json).",
    ].join("\n");
    const rows = extractEvidenceRows(body);
    assert.ok(!rows.get("domain-artifacts").includes("example.com"));
    assert.equal(isRowSatisfied(rows.get("domain-artifacts")), false);
  });

  it("boundRowBlock stops at the first blank line or heading", () => {
    const block = [
      "- [ ] row text",
      "      continued indented line",
      "",
      "# not part of the row",
      "https://example.com/should-not-be-captured",
    ].join("\n");
    const bounded = boundRowBlock(block);
    assert.ok(bounded.includes("continued indented line"));
    assert.ok(!bounded.includes("example.com"));
  });
});

describe("check-pr-evidence against the real PR template", () => {
  it("carries a marker for every required evidence row", () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    const rows = extractEvidenceRows(template);
    for (const { id } of REQUIRED_EVIDENCE_ROWS) {
      assert.ok(rows.has(id), `template is missing marker evidence-row:${id}`);
    }
  });

  it("fails the unedited template", () => {
    const template = readFileSync(TEMPLATE_PATH, "utf8");
    const { ok, findings } = evaluatePrEvidence(template);
    assert.equal(ok, false);
    assert.ok(findings.every((finding) => finding.status === "blank"));
  });
});
