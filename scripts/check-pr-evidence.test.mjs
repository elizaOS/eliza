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
  hasEvidenceFileReference,
  hasNaWithReason,
  hasOcrEvidenceReference,
  hasVisualArtifactReference,
  isChecked,
  isRowSatisfied,
  isRowSatisfiedForContext,
  markerFreeBodyHint,
  parseLabels,
  REQUIRED_EVIDENCE_ROWS,
  requiresSurfaceArtifacts,
  requiresSurfaceArtifactsFromFiles,
  runSelfTest,
  SURFACE_ARTIFACT_ROW_IDS,
  verifyReferencedArtifacts,
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
      "- [ ] Real-LLM trajectory: [report](https://github.com/elizaOS/eliza/releases/download/pr-evidence/fixture-trajectory.json)",
    "domain-artifacts":
      "- [ ] Domain artifacts: OCR report https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000007",
  };
  const merged = { ...defaults, ...overrides };
  return REQUIRED_EVIDENCE_ROWS.map(
    ({ id }) => `<!-- evidence-row:${id} -->\n${merged[id] ?? ""}`,
  ).join("\n\n");
}

const uploadUrl = (suffix) =>
  `https://github.com/user-attachments/assets/00000000-0000-0000-0000-${String(suffix).padStart(12, "0")}`;

function buildSevenArtifactBody() {
  return buildBody({
    "before-screenshots": `- [x] ![before](${uploadUrl(1)})`,
    "after-screenshots": `- [x] ![after](${uploadUrl(2)})`,
    "walkthrough-video": `- [x] ${uploadUrl(3)}`,
    "backend-logs": `- [x] [backend logs](${uploadUrl(4)})`,
    "frontend-logs": `- [x] [frontend logs](${uploadUrl(5)})`,
    "llm-trajectory": `- [x] [trajectory](${uploadUrl(6)})`,
    "domain-artifacts": `- [x] [domain artifact](${uploadUrl(7)})`,
  });
}

function buildSingleArtifactBody(id, text) {
  const rows = Object.fromEntries(
    REQUIRED_EVIDENCE_ROWS.map(({ id: rowId }) => [
      rowId,
      "- [ ] `N/A - this evidence type does not apply here`.",
    ]),
  );
  rows[id] = text;
  return buildBody(rows);
}

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

function validArtifactResponse(url) {
  if (url.endsWith("000000000001") || url.endsWith("000000000002")) {
    return new Response(PNG_BYTES, {
      headers: { "content-type": "image/png" },
    });
  }
  if (url.endsWith("000000000003")) {
    return new Response(MP4_BYTES, {
      headers: { "content-type": "video/mp4" },
    });
  }
  return new Response("2026-07-30 INFO verified evidence artifact\n", {
    headers: { "content-type": "text/plain" },
  });
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

  it("fails fabricated URLs, tags, filenames, and local report links", () => {
    const body = buildBody({
      "before-screenshots": "- [x] ![before](not-a-url)",
      "after-screenshots":
        '- [x] <img src="https://example.invalid/after.jpg">',
      "walkthrough-video": "- [x] walkthrough.mp4",
      "backend-logs": "- [x] [backend](https://example.invalid/backend.log)",
      "frontend-logs": "- [x] https://example.invalid/network.json",
      "llm-trajectory": "- [x] [trajectory](trajectory.json)",
      "domain-artifacts": "- [x] OCR report [ocr](ocr.txt)",
    });
    const { ok, findings } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles: ["packages/eliza-computer/src/App.tsx"],
    });
    assert.equal(ok, false);
    assert.ok(
      findings
        .filter((finding) => finding.id !== "ocr-review")
        .every((finding) => finding.status !== "ok"),
    );
    assert.equal(
      findings.find((finding) => finding.id === "ocr-review")?.status,
      "ocr-required",
    );
  });

  it("fails duplicate evidence markers instead of choosing a convenient copy", () => {
    const body = `${buildBody()}\n\n<!-- evidence-row:backend-logs -->\n- [ ] Backend logs \`N/A - duplicate marker should never be accepted\`.`;
    const result = evaluatePrEvidence(body);
    assert.equal(result.ok, false);
    assert.equal(
      result.findings.find((finding) => finding.id === "backend-logs")?.status,
      "duplicate",
    );
  });

  it("fails every row that reuses a trusted artifact from another row", () => {
    const reused = uploadUrl(41);
    const result = evaluatePrEvidence(
      buildBody({
        "backend-logs": `- [x] [backend logs](${reused}?download=backend)`,
        "llm-trajectory": `- [x] [trajectory](${reused}?download=trajectory)`,
      }),
    );
    assert.equal(result.ok, false);
    for (const id of ["backend-logs", "llm-trajectory"]) {
      const finding = result.findings.find((entry) => entry.id === id);
      assert.equal(finding?.status, "duplicate-artifact");
      assert.match(finding?.detail ?? "", /also used by/);
    }
  });

  it("deduplicates repeated uses of an artifact within one row", () => {
    const repeated = uploadUrl(42);
    const result = evaluatePrEvidence(
      buildBody({
        "backend-logs": `- [x] [backend logs](${repeated}) and [the same logs again](${repeated})`,
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(
      result.findings.find((entry) => entry.id === "backend-logs")?.status,
      "ok",
    );
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
          "- [ ] Before screenshots: ![before](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000002)",
        "after-screenshots":
          "- [ ] After screenshots: ![after](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000003)",
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
          "- [ ] Before screenshots: ![before](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000002)",
        "after-screenshots":
          "- [ ] After screenshots: ![after](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000003)",
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

  it("reports a prose-only body (template markers deleted) as all-missing", () => {
    // The #16925/#16913 failure shape: an agent-authored body that talks about
    // evidence in prose but carries none of the template's HTML markers. The
    // gate cannot match prose — every required row is missing, and the CLI
    // keys its "re-add the markers" hint off this exact all-missing shape.
    const { ok, findings } = evaluatePrEvidence(
      "Evidence rows: UI/video/frontend `N/A - cloud backend latency`. Backend: 51-test run above.",
    );
    assert.equal(ok, false);
    assert.equal(findings.length, REQUIRED_EVIDENCE_ROWS.length);
    assert.ok(findings.every((finding) => finding.status === "missing"));
  });

  it("marker-free hint names the marker mechanism and one --row flag per required row", () => {
    // The hint is the fix instruction shown on the #16925/#16913 shape; a row
    // list that drifted from REQUIRED_EVIDENCE_ROWS would tell authors to
    // patch the wrong rows — the exact misdiagnosis class the hint exists to
    // prevent.
    const hint = markerFreeBodyHint();
    assert.match(hint, /NO evidence-row markers found/);
    assert.match(hint, /<!-- evidence-row:<id> -->/);
    assert.match(hint, /pr-evidence\.mjs rows/);
    for (const { id } of REQUIRED_EVIDENCE_ROWS) {
      assert.ok(hint.includes(`--row ${id}=`), `hint must offer --row ${id}=…`);
    }
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
    assert.equal(hasNaWithReason("N/A - nope"), false);
    assert.equal(hasNaWithReason("N/A - not applicable"), false);
    assert.equal(hasNaWithReason("N/A - see https://example.invalid"), false);
    assert.equal(hasNaWithReason("N/A - <reason>."), false);
  });

  it("accepts only repository evidence uploads, not arbitrary links", () => {
    assert.equal(hasArtifactReference("[report](https://x/y.json)"), false);
    assert.equal(
      hasArtifactReference("see https://github.com/o/r/assets/1"),
      false,
    );
    assert.equal(
      hasArtifactReference(
        "see https://user-images.githubusercontent.com/1/a.jpg",
      ),
      true,
    );
    assert.equal(
      hasArtifactReference(
        "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
      ),
      true,
    );
    for (const lookalike of [
      "https://github.com.evil.invalid/user-attachments/assets/00000000-0000-0000-0000-000000000001",
      "https://github.com/other/repo/releases/download/pr-evidence/report.json",
      "https://github.com/elizaOS/eliza/releases/tag/pr-evidence",
      "https://github.com/user-attachments/assets/not-a-uuid",
      "https://github.com/elizaOS/eliza/releases/download/pr-evidence/%E0%A4%A",
    ]) {
      assert.equal(hasArtifactReference(lookalike), false, lookalike);
    }
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
    // GitHub-hosted uploads count; lookalike markup and filenames do not.
    assert.equal(
      hasVisualArtifactReference(
        "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
      ),
      true,
    );
    assert.equal(
      hasVisualArtifactReference("![after](https://example.com/x/after)"),
      false,
    );
    assert.equal(
      hasVisualArtifactReference(
        '<img src="https://example.com/shot" width="400">',
      ),
      false,
    );
    assert.equal(
      hasVisualArtifactReference("see https://example.com/walkthrough.mp4"),
      false,
    );
    assert.equal(
      hasVisualArtifactReference(
        "![after](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000002)",
        "image",
      ),
      true,
    );
  });

  it("does not let an image satisfy video or a video satisfy screenshot evidence", () => {
    const release =
      "https://github.com/elizaOS/eliza/releases/download/pr-evidence";
    assert.equal(
      hasVisualArtifactReference(`${release}/walkthrough.mp4`, "image"),
      false,
    );
    assert.equal(
      hasVisualArtifactReference(`${release}/after.jpg`, "video"),
      false,
    );
    assert.equal(
      hasVisualArtifactReference(
        "![after](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000002)",
        "video",
      ),
      false,
    );
  });

  it("requires an OCR report rather than OCR text on an image embed", () => {
    const imageOnly = new Map([
      [
        "after-screenshots",
        "![OCR reviewed](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000002)",
      ],
    ]);
    assert.equal(hasOcrEvidenceReference(imageOnly), false);
    assert.equal(
      hasEvidenceFileReference(`<video src="${uploadUrl(10)}"></video>`),
      false,
    );
  });

  it("accepts substantive inline logs but rejects placeholder details", () => {
    const backend = [
      "- [x] Backend logs:",
      "<details><summary>Backend logs</summary>",
      "```text",
      "2026-07-30T18:01:12Z INFO GET /api/contributions request_id=abc123",
      "2026-07-30T18:01:12Z INFO statusCode=200 count=313 duration_ms=84",
      "2026-07-30T18:01:12Z INFO response bytes=42819 cache=miss",
      "```",
      "</details>",
    ].join("\n");
    assert.equal(
      evaluatePrEvidence(buildBody({ "backend-logs": backend })).ok,
      true,
    );

    const placeholder = [
      "- [x] Backend logs:",
      "<details><summary>Backend logs</summary>",
      "```text",
      "logs here",
      "todo",
      "placeholder",
      "```",
      "</details>",
    ].join("\n");
    const result = evaluatePrEvidence(
      buildBody({ "backend-logs": placeholder }),
    );
    assert.equal(result.ok, false);
    assert.equal(
      result.findings.find((finding) => finding.id === "backend-logs")?.status,
      "blank",
    );
  });

  it("rejects inline logs that confess to non-real evidence", () => {
    for (const term of [
      "fabricated",
      "invented",
      "fake",
      "mock",
      "fixture",
      "synthetic",
      "dummy",
    ]) {
      const confessed = [
        "- [x] Backend logs:",
        "<details><summary>Backend logs</summary>",
        "```text",
        `2026-07-30T18:01:12Z INFO GET /api/contributions source=${term}`,
        "2026-07-30T18:01:12Z INFO statusCode=200 count=313 duration_ms=84",
        "2026-07-30T18:01:12Z INFO response bytes=42819 cache=miss",
        "```",
        "</details>",
      ].join("\n");
      const result = evaluatePrEvidence(
        buildBody({ "backend-logs": confessed }),
      );
      assert.equal(result.ok, false, term);
      assert.equal(
        result.findings.find((finding) => finding.id === "backend-logs")
          ?.status,
        "blank",
        term,
      );
    }
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
      requiresSurfaceArtifactsFromFiles([String.raw`apps\app\src\Panel.tsx`]),
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
      changedFiles: [
        "packages/ui/src/navigation/index.ts",
        "packages/ui/src/components/Foo.tsx",
      ],
    });
    assert.equal(forced.ok, false);

    const contributionSite = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      labels: "",
      changedFiles: ["packages/eliza-computer/src/App.tsx"],
    });
    assert.equal(
      contributionSite.ok,
      false,
      "eliza.computer is a rendered UI surface and requires visual proof",
    );
  });

  it("normalizes labels and detects surface labels", () => {
    assert.deepEqual(parseLabels("bug, UI\nNative"), ["bug", "ui", "native"]);
    assert.equal(requiresSurfaceArtifacts("testing,backend"), false);
    assert.equal(requiresSurfaceArtifacts(["ci", "Frontend"]), true);
  });

  it("requires N/A-reason or artifact to satisfy a row", () => {
    assert.equal(isRowSatisfied("- [ ] `N/A - no runtime path changed`"), true);
    assert.equal(isRowSatisfied("- [ ] [proof](https://e/x.png)"), false);
    assert.equal(
      isRowSatisfied(
        "- [ ] [proof](https://github.com/elizaOS/eliza/releases/download/pr-evidence/proof.png)",
      ),
      true,
    );
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

describe("check-pr-evidence pr-evidence release family", () => {
  const dl = (tag, name) =>
    `https://github.com/elizaOS/eliza/releases/download/${tag}/${name}`;

  it("accepts an overflow-release screenshot on a visual row exactly like the primary release", () => {
    // The unblock: once `pr-evidence` fills, pr-evidence.mjs emits pr-evidence-N
    // URLs; a media asset there must satisfy the visual rows identically.
    assert.equal(
      hasVisualArtifactReference(dl("pr-evidence", "15171-after-desktop.jpg")),
      true,
    );
    assert.equal(
      hasVisualArtifactReference(
        dl("pr-evidence-2", "16367-after-desktop.jpg"),
      ),
      true,
    );
    assert.equal(
      hasVisualArtifactReference(dl("pr-evidence-3", "16367-walkthrough.mp4")),
      true,
    );
  });

  it("recognizes any pr-evidence-family asset as an evidence file, even a non-whitelisted extension", () => {
    // A `.jsonl` is not in EVIDENCE_FILE_RE, so acceptance here comes from the
    // release-family host matcher — the generalized rule, applied to overflow
    // releases too.
    assert.equal(
      EVIDENCE_FILE_RE_MATCHES(".jsonl"),
      false,
      "guard: .jsonl must not be a whitelisted evidence extension",
    );
    assert.equal(
      hasEvidenceFileReference(dl("pr-evidence", "15171-ocr-readout.txt")),
      true,
    );
    assert.equal(
      hasEvidenceFileReference(dl("pr-evidence-3", "16367-ocr-readout.jsonl")),
      true,
    );
  });

  it("does NOT accept a link to the release PAGE (no /download/ asset path)", () => {
    // Strictness: the tag page is not an asset. A page link never counts as a
    // screenshot, and never as an evidence file.
    const pageLink =
      "https://github.com/elizaOS/eliza/releases/tag/pr-evidence-2";
    assert.equal(hasVisualArtifactReference(pageLink), false);
    assert.equal(hasEvidenceFileReference(pageLink), false);
  });

  it("passes a UI-file surface PR whose screenshots live on an overflow release", () => {
    const body = buildBody({
      "before-screenshots": `- [x] ![before](${dl("pr-evidence-2", "16367-before-desktop.jpg")})`,
      "after-screenshots": `- [x] ![after](${dl("pr-evidence-2", "16367-after-desktop.jpg")})`,
      "walkthrough-video": `- [x] ${dl("pr-evidence-2", "16367-walkthrough.mp4")}`,
      "domain-artifacts": `- [ ] OCR text readout: ${dl("pr-evidence-2", "16367-ocr.txt")}`,
    });
    const changedFiles = ["packages/ui/src/components/Foo.tsx"];
    const { ok } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles,
    });
    assert.equal(ok, true);
  });

  it("still FAILS a UI-file surface PR with no real media, even citing the release page", () => {
    // Invariant: the storage location changed, the strictness did not.
    const body = buildBody({
      "before-screenshots":
        "- [ ] Before screenshots: https://github.com/elizaOS/eliza/releases/tag/pr-evidence-2",
      "after-screenshots": "- [ ] After screenshots `N/A - nothing to show`.",
      "walkthrough-video": "- [ ] Walkthrough video `N/A - nothing to show`.",
    });
    const { ok, findings } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles: ["packages/ui/src/components/Foo.tsx"],
    });
    assert.equal(ok, false);
    for (const id of SURFACE_ARTIFACT_ROW_IDS) {
      assert.equal(
        findings.find((finding) => finding.id === id).status,
        "artifact-required",
      );
    }
  });
});

// Mirror of check-pr-evidence's internal EVIDENCE_FILE_RE, used only to prove
// the release-family matcher (not the extension whitelist) is what accepts a
// pr-evidence `.jsonl` asset above.
function EVIDENCE_FILE_RE_MATCHES(ext) {
  return /\.(json|txt|log|csv|md)(\?\S*)?(\s|$|\)|"|')/i.test(`file${ext} `);
}

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

describe("evaluatePrEvidence verdicts", () => {
  it("passes a fully evidenced backend-only body with no surface trigger", () => {
    const { ok, findings } = evaluatePrEvidence(buildBody());
    assert.equal(ok, true);
    assert.ok(findings.every((finding) => finding.status === "ok"));
  });

  it("reports a missing marker as missing and a blank row as blank", () => {
    const body = buildBody({ "backend-logs": "" });
    const { ok, findings } = evaluatePrEvidence(body);
    assert.equal(ok, false);
    assert.equal(
      findings.find((finding) => finding.id === "backend-logs")?.status,
      "blank",
    );
    const withoutMarker = buildBody();
    const truncated = withoutMarker.replace(
      /<!-- evidence-row:llm-trajectory -->[\s\S]*?(?=\n\n<!-- evidence-row:|$)/,
      "",
    );
    const missing = evaluatePrEvidence(truncated).findings.find(
      (finding) => finding.id === "llm-trajectory",
    );
    assert.equal(missing?.status, "missing");
  });

  it("path detection overrides labels: a UI .tsx diff forces real media on visual rows", () => {
    const { ok, findings } = evaluatePrEvidence(
      buildBody(),
      REQUIRED_EVIDENCE_ROWS,
      { changedFiles: ["packages/app/src/views/Home.tsx"] },
    );
    assert.equal(ok, false);
    for (const id of ["before-screenshots", "after-screenshots"]) {
      assert.equal(
        findings.find((finding) => finding.id === id)?.status,
        "artifact-required",
        `${id} should demand media on a surface diff`,
      );
    }
    // buildBody's domain-artifacts row carries OCR proof, so no ocr-required
    // finding is appended here; the label-only case below covers that path.
  });

  it("a non-visual diff under a UI package does NOT force surface artifacts even with a ui label", () => {
    const { ok } = evaluatePrEvidence(buildBody(), REQUIRED_EVIDENCE_ROWS, {
      labels: "ui",
      changedFiles: ["packages/ui/src/state/useThing.ts"],
    });
    assert.equal(ok, true);
  });

  it("label-only invocation still triggers the surface requirement", () => {
    const { findings } = evaluatePrEvidence(
      buildBody(),
      REQUIRED_EVIDENCE_ROWS,
      {
        labels: "native",
      },
    );
    assert.equal(
      findings.find((finding) => finding.id === "before-screenshots")?.status,
      "artifact-required",
    );
    // Without any OCR-referencing row, the surface trigger also appends the
    // ocr-review requirement.
    const noOcr = evaluatePrEvidence(
      buildBody({ "domain-artifacts": "- [ ] `N/A - no domain artifacts`." }),
      REQUIRED_EVIDENCE_ROWS,
      { labels: "native" },
    );
    assert.equal(
      noOcr.findings.find((finding) => finding.id === "ocr-review")?.status,
      "ocr-required",
    );
  });

  it("allows N/A before-screenshots when every touched UI file was added", () => {
    const surface = ["packages/ui/src/components/New.tsx"];
    const body = buildBody({
      "before-screenshots":
        "- [ ] Before screenshots `N/A - brand-new surface, no before state`.",
      "after-screenshots":
        "- [x] ![after](https://github.com/elizaOS/eliza/releases/download/pr-evidence/1-a.jpg)",
      "walkthrough-video":
        "- [x] https://github.com/elizaOS/eliza/releases/download/pr-evidence/1-w.mp4",
      "domain-artifacts":
        "- [x] OCR text readout: https://github.com/elizaOS/eliza/releases/download/pr-evidence/1-ocr.json",
    });
    const allNew = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles: surface,
      addedFiles: surface,
    });
    assert.equal(allNew.ok, true);
    const modified = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles: surface,
      addedFiles: [],
    });
    assert.equal(
      modified.findings.find((finding) => finding.id === "before-screenshots")
        ?.status,
      "artifact-required",
    );
  });

  it("accepts overflow-release (pr-evidence-N) media on a surface PR", () => {
    const dl = (tag, name) =>
      `https://github.com/elizaOS/eliza/releases/download/${tag}/${name}`;
    const { ok } = evaluatePrEvidence(
      buildBody({
        "before-screenshots": `- [x] ![before](${dl("pr-evidence-2", "9-b.jpg")})`,
        "after-screenshots": `- [x] ![after](${dl("pr-evidence-2", "9-a.jpg")})`,
        "walkthrough-video": `- [x] ${dl("pr-evidence-3", "9-w.mp4")}`,
        "domain-artifacts": `- [x] OCR readout ${dl("pr-evidence-3", "9-ocr.jsonl")}`,
      }),
      REQUIRED_EVIDENCE_ROWS,
      { changedFiles: ["packages/ui/src/components/Foo.tsx"] },
    );
    assert.equal(ok, true);
  });

  it("rejects a release-page link standing in for a screenshot", () => {
    const { findings } = evaluatePrEvidence(
      buildBody({
        "before-screenshots":
          "- [ ] https://github.com/elizaOS/eliza/releases/tag/pr-evidence-2",
      }),
      REQUIRED_EVIDENCE_ROWS,
      { changedFiles: ["packages/ui/src/components/Foo.tsx"] },
    );
    assert.equal(
      findings.find((finding) => finding.id === "before-screenshots")?.status,
      "artifact-required",
    );
  });

  it("empty body reports every required row missing", () => {
    const { ok, findings } = evaluatePrEvidence("");
    assert.equal(ok, false);
    assert.equal(findings.length, REQUIRED_EVIDENCE_ROWS.length);
    assert.ok(findings.every((finding) => finding.status === "missing"));
  });
});

describe("remote artifact verification", () => {
  it("fetches every distinct artifact with bounded concurrency, redirects, range, and an optional token", async () => {
    let active = 0;
    let maximumActive = 0;
    const calls = [];
    const result = await verifyReferencedArtifacts(
      buildSevenArtifactBody(),
      REQUIRED_EVIDENCE_ROWS,
      {
        concurrency: 2,
        fetchImpl: async (url, init) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          calls.push({ init, url });
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
          return validArtifactResponse(url);
        },
        token: "test-token",
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 7);
    assert.equal(calls.length, 7);
    assert.ok(maximumActive <= 2);
    for (const { init } of calls) {
      const headers = new Headers(init.headers);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "follow");
      assert.equal(headers.get("authorization"), "Bearer test-token");
      assert.equal(headers.get("range"), "bytes=0-16383");
    }
  });

  it("rejects seven distinct nonexistent but syntactically trusted UUIDs", async () => {
    let requests = 0;
    const result = await verifyReferencedArtifacts(
      buildSevenArtifactBody(),
      REQUIRED_EVIDENCE_ROWS,
      {
        fetchImpl: async () => {
          requests += 1;
          return new Response("not found", { status: 404 });
        },
      },
    );

    assert.equal(requests, 7);
    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 7);
    assert.ok(
      result.findings.every(
        (finding) => finding.status === "artifact-http-error",
      ),
    );
  });

  it("deduplicates one remote request for a URL repeated within a row", async () => {
    const repeated = uploadUrl(71);
    let requests = 0;
    const result = await verifyReferencedArtifacts(
      buildSingleArtifactBody(
        "backend-logs",
        `- [x] [logs](${repeated}) and [logs again](${repeated})`,
      ),
      REQUIRED_EVIDENCE_ROWS,
      {
        fetchImpl: async (url) => {
          requests += 1;
          return validArtifactResponse(url);
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(requests, 1);
    assert.equal(result.findings.length, 1);
  });

  it("never fetches arbitrary URLs that deterministic validation rejects", async () => {
    const body = buildSingleArtifactBody(
      "backend-logs",
      "- [x] [logs](https://example.invalid/backend.log)",
    );
    let requests = 0;
    const result = await verifyReferencedArtifacts(
      body,
      REQUIRED_EVIDENCE_ROWS,
      {
        fetchImpl: async () => {
          requests += 1;
          throw new Error("untrusted URL must not reach fetch");
        },
      },
    );
    assert.equal(evaluatePrEvidence(body).ok, false);
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
    assert.equal(requests, 0);
  });

  it("rejects empty, HTML, disguised HTML, and mismatched media responses", async () => {
    const cases = [
      {
        expectedStatus: "artifact-empty",
        response: new Response(null),
      },
      {
        expectedStatus: "artifact-html",
        response: new Response("<!doctype html><html>login</html>", {
          headers: { "content-type": "text/html" },
        }),
      },
      {
        expectedStatus: "artifact-html",
        response: new Response("  <html>not an artifact</html>", {
          headers: { "content-type": "application/octet-stream" },
        }),
      },
      {
        expectedStatus: "artifact-kind-mismatch",
        response: new Response(MP4_BYTES, {
          headers: { "content-type": "video/mp4" },
        }),
      },
    ];

    for (const { expectedStatus, response } of cases) {
      const result = await verifyReferencedArtifacts(
        buildSingleArtifactBody(
          "after-screenshots",
          `- [x] ![after](${uploadUrl(81)})`,
        ),
        REQUIRED_EVIDENCE_ROWS,
        { fetchImpl: async () => response },
      );
      assert.equal(result.ok, false, expectedStatus);
      assert.equal(result.findings[0]?.status, expectedStatus);
    }
  });

  it("rejects an image served behind a bare URL claimed as an OCR report", async () => {
    const result = await verifyReferencedArtifacts(
      buildSingleArtifactBody(
        "domain-artifacts",
        `- [x] OCR text readout: ${uploadUrl(82)}`,
      ),
      REQUIRED_EVIDENCE_ROWS,
      {
        fetchImpl: async () =>
          new Response(PNG_BYTES, {
            headers: { "content-type": "image/png" },
          }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.findings[0]?.status, "artifact-kind-mismatch");
  });

  it("turns a timed-out fetch into an explicit row failure", async () => {
    const result = await verifyReferencedArtifacts(
      buildSingleArtifactBody("backend-logs", `- [x] [logs](${uploadUrl(91)})`),
      REQUIRED_EVIDENCE_ROWS,
      {
        fetchImpl: (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        timeoutMs: 5,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.findings[0]?.status, "artifact-timeout");
  });
});

describe("planted-fixture self-test", () => {
  it("passes against the current gate rules", () => {
    // runSelfTest exercises the same fixtures CI's --self-test flag does and
    // process.exit(1)s on any regression; completing without exit is the pass.
    runSelfTest();
  });
});
