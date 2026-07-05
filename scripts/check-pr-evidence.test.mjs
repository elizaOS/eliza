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
  hasArtifactReference,
  hasNaWithReason,
  isChecked,
  isRowSatisfied,
  isRowSatisfiedForContext,
  parseLabels,
  REQUIRED_EVIDENCE_ROWS,
  requiresSurfaceArtifacts,
  SURFACE_ARTIFACT_ROW_IDS,
} from "./check-pr-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(HERE, "..", ".github", "pull_request_template.md");

function buildBody(overrides = {}) {
  const defaults = {
    "before-screenshots":
      "- [ ] Before screenshots `N/A - backend-only change, no UI surface`.",
    "after-screenshots":
      "- [ ] After screenshots `N/A - backend-only change, no UI surface`.",
    "walkthrough-video":
      "- [x] A video walkthrough: .github/issue-evidence/13676-video.mp4",
    "backend-logs":
      "- [ ] Backend logs: see .github/issue-evidence/13676-backend.txt",
    "frontend-logs": "- [ ] Frontend logs `N/A - no frontend change`.",
    "llm-trajectory":
      "- [ ] Real-LLM trajectory: [report](https://example.com/report.json)",
    "domain-artifacts":
      "- [ ] Domain artifacts `N/A - no domain artifacts produced`.",
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
  });

  it("passes UI-labeled PRs when screenshot/video rows have concrete artifacts", () => {
    const { ok, findings } = evaluatePrEvidence(
      buildBody({
        "before-screenshots":
          "- [ ] Before screenshots: .github/issue-evidence/13622-before.png",
        "after-screenshots":
          "- [ ] After screenshots: .github/issue-evidence/13622-after.png",
        "walkthrough-video":
          "- [ ] Walkthrough video: .github/issue-evidence/13622-demo.webm",
      }),
      REQUIRED_EVIDENCE_ROWS,
      { labels: "frontend" },
    );
    assert.equal(ok, true);
    assert.ok(findings.every((finding) => finding.status === "ok"));
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

  it("detects links, URLs, and issue-evidence paths", () => {
    assert.equal(hasArtifactReference("[report](https://x/y.json)"), true);
    assert.equal(
      hasArtifactReference("see https://github.com/o/r/assets/1"),
      true,
    );
    assert.equal(
      hasArtifactReference(
        "committed under .github/issue-evidence/13676-a.png",
      ),
      true,
    );
    assert.equal(hasArtifactReference("just words, no artifact"), false);
  });

  it("detects checked checkboxes without treating them as evidence", () => {
    assert.equal(isChecked("- [x] done"), true);
    assert.equal(isChecked("- [X] done"), true);
    assert.equal(isChecked("- [ ] not done"), false);
    assert.equal(isRowSatisfied("- [x] done"), false);
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
      isRowSatisfiedForContext("- [ ] .github/issue-evidence/13622-ui.png", {
        artifactRequired: true,
      }),
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
      "- [ ] Frontend logs: .github/issue-evidence/13676-frontend.txt",
    ].join("\n");
    const rows = extractEvidenceRows(body);
    assert.ok(rows.get("backend-logs").includes("N/A - no backend path"));
    assert.ok(rows.get("frontend-logs").includes("13676-frontend.txt"));
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
