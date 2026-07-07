#!/usr/bin/env node
/**
 * Mechanical PR evidence gate for the evidence rows in the pull request
 * template. The template keeps stable HTML markers above each required row so
 * this checker can ignore row prose churn while still failing closed when a row
 * is blank, checkbox-only, or removed.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REQUIRED_EVIDENCE_ROWS = [
  { id: "before-screenshots", label: "Before screenshots" },
  { id: "after-screenshots", label: "After screenshots" },
  { id: "walkthrough-video", label: "Walkthrough video" },
  { id: "backend-logs", label: "Backend logs" },
  { id: "frontend-logs", label: "Frontend console/network logs" },
  { id: "llm-trajectory", label: "Real-LLM trajectory" },
  { id: "domain-artifacts", label: "Domain artifacts" },
];

export const SURFACE_EVIDENCE_LABELS = ["ui", "frontend", "native"];
export const SURFACE_ARTIFACT_ROW_IDS = [
  "before-screenshots",
  "after-screenshots",
  "walkthrough-video",
];
export const SURFACE_OCR_EVIDENCE_ROW = {
  id: "ocr-review",
  label: "OCR visual text review",
};

/**
 * A changed file forces surface artifacts when it is a rendered-UI source file
 * — labels are advisory and agents routinely omit them, so the gate cannot rely
 * on them alone. Detection is deliberately narrow: a visual EXTENSION (`.tsx`,
 * CSS family, `.svg`, `.html`, `.vue`) under a UI-bearing PACKAGE, excluding
 * test/story/fixture files that render nothing a user sees. This is why editing
 * a real component in `packages/ui` or `packages/app` demands screenshots while
 * editing its `*.test.tsx` or `*.stories.tsx` does not.
 */
const SURFACE_PATH_RE =
  /(^|\/)(packages\/(app|ui|tui|homepage)|apps\/app|packages\/cloud\/frontend|packages\/os\/landing)\//i;
const SURFACE_VISUAL_EXT_RE = /\.(tsx|jsx|css|scss|sass|less|svg|html|vue)$/i;
const SURFACE_NON_VISUAL_RE =
  /(\.(test|spec|stories|story|bench)\.|\.d\.ts$|(^|\/)(__tests__|__e2e__|__mocks__|__fixtures__|test|tests|e2e|stories)\/)/i;

/**
 * True when any changed file is a rendered-UI source file (see `SURFACE_PATH_RE`
 * rationale). Backslash paths from a Windows runner are normalized so the same
 * diff classifies identically on either OS.
 */
export function requiresSurfaceArtifactsFromFiles(files) {
  return parseChangedFiles(files).some((raw) => {
    const file = raw.replaceAll("\\", "/");
    return (
      SURFACE_PATH_RE.test(file) &&
      SURFACE_VISUAL_EXT_RE.test(file) &&
      !SURFACE_NON_VISUAL_RE.test(file)
    );
  });
}
const OCR_EVIDENCE_RE =
  /\bOCR\b|ocr-triage|mvp:visual-verify|audit:app:verify|tesseract|text readout/i;

const MARKER_RE = /<!--\s*evidence-row:([a-z0-9-]+)\s*-->/gi;
const RETIRED_REPO_EVIDENCE_PATH = [
  ".github",
  ["issue", "evidence"].join("-"),
].join("/");
const RETIRED_REPO_EVIDENCE_RE = new RegExp(
  `${RETIRED_REPO_EVIDENCE_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/\\S+`,
  "i",
);

export function parseLabels(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((label) => parseLabels(label))
      .filter((label, index, labels) => labels.indexOf(label) === index);
  }
  return String(value ?? "")
    .split(/[\n,]/)
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

export function requiresSurfaceArtifacts(labels) {
  const labelSet = new Set(parseLabels(labels));
  return SURFACE_EVIDENCE_LABELS.some((label) => labelSet.has(label));
}

export function hasOcrEvidenceReference(rows) {
  for (const rowText of rows.values()) {
    // OCR proof must reference real evidence, not a page link: either an
    // actual media artifact or a linked report/log file next to OCR keywords.
    if (
      OCR_EVIDENCE_RE.test(rowText) &&
      (hasVisualArtifactReference(rowText) ||
        hasEvidenceFileReference(rowText))
    ) {
      return true;
    }
  }
  return false;
}

// Linked non-media evidence file (an OCR report/JSON/log) — still stricter
// than "any URL": the link target must look like a file, not a web page.
const EVIDENCE_FILE_RE = /\.(json|txt|log|csv|md)(\?\S*)?(\s|$|\)|"|')/i;

export function hasEvidenceFileReference(text) {
  const value = String(text ?? "");
  return (
    (EVIDENCE_FILE_RE.test(value) || GITHUB_ATTACHMENT_RE.test(value)) &&
    !RETIRED_REPO_EVIDENCE_RE.test(value)
  );
}

export function hasNaWithReason(text) {
  const match = text.match(/\bN\/?A\b\s*[-:\u2013\u2014]\s*(\S[\s\S]*?)$/im);
  if (!match) return false;
  const reason = match[1].trim();
  if (reason.length < 3) return false;
  const stripped = reason.replace(/[`*_]+/g, "").trim();
  return !/^<[^>]*>[.\s]*$/.test(stripped);
}

export function hasArtifactReference(text) {
  const markdownLinks = [
    ...String(text ?? "").matchAll(/\[[^\]]+\]\(\s*(\S+)\s*\)/g),
  ];
  if (markdownLinks.some((match) => !RETIRED_REPO_EVIDENCE_RE.test(match[1]))) {
    return true;
  }
  if (/https?:\/\/\S+/i.test(text)) return true;
  if (
    /user-images\.githubusercontent\.com|github\.com\/[^)\s]+\/assets\//i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

// A GitHub-uploaded attachment (drag-and-drop) lands on one of these hosts;
// these URLs are the unforgeable signal that a real image/video is embedded.
const GITHUB_ATTACHMENT_RE =
  /(https?:\/\/)?(github\.com\/user-attachments\/assets\/|user-images\.githubusercontent\.com\/|github\.com\/[^/\s)]+\/[^/\s)]+\/assets\/)/i;
// A URL/path whose tail is an image or video file — a directly-linked media file.
const MEDIA_EXT_RE =
  /\.(png|jpe?g|gif|webp|apng|avif|bmp|svg|mp4|mov|webm|m4v|ogg)(\?\S*)?(\s|$|\)|"|')/i;

/**
 * Strict media check for the VISUAL evidence rows (screenshots, walkthrough
 * video, OCR readout). Unlike `hasArtifactReference`, a bare link to a page —
 * the PR itself, a `/checks` tab, a commit, a job log — does NOT count: those
 * are how an author games the loose check while attaching no pixels. Only a
 * real embedded/linked image or video satisfies it: a GitHub attachment-host
 * URL, a markdown image embed `![](…)`, an `<img>`/`<video>` tag, or a URL/path
 * ending in a known media extension. This is the difference between "here is a
 * link" and "here is the picture".
 */
export function hasVisualArtifactReference(text) {
  const value = String(text ?? "");
  if (GITHUB_ATTACHMENT_RE.test(value)) return true;
  if (/!\[[^\]]*\]\(\s*\S+\s*\)/.test(value)) return true; // ![alt](url) embed
  if (/<(img|video|source|picture)\b[^>]*>/i.test(value)) return true;
  if (MEDIA_EXT_RE.test(value) && !RETIRED_REPO_EVIDENCE_RE.test(value)) {
    return true;
  }
  return false;
}

export function parseChangedFiles(value) {
  if (Array.isArray(value))
    return value.flatMap((entry) => parseChangedFiles(entry));
  return String(value ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function findRetiredRepoEvidenceFiles(files) {
  return parseChangedFiles(files).filter((file) =>
    file.replaceAll("\\", "/").startsWith(`${RETIRED_REPO_EVIDENCE_PATH}/`),
  );
}

export function isChecked(rowText) {
  return /^\s*[-*]\s*\[\s*[xX]\s*\]/m.test(rowText);
}

export function isRowSatisfied(rowText) {
  return hasNaWithReason(rowText) || hasArtifactReference(rowText);
}

export function isRowSatisfiedForContext(
  rowText,
  { artifactRequired = false } = {},
) {
  if (artifactRequired) return hasArtifactReference(rowText);
  return isRowSatisfied(rowText);
}

export function boundRowBlock(block) {
  const lines = block.split(/\r?\n/);
  const out = [];
  let started = false;
  for (const line of lines) {
    if (!started) {
      if (line.trim() === "") continue;
      started = true;
      out.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "") break;
    if (/^#/.test(trimmed)) break;
    if (/<!--\s*evidence-row:/i.test(trimmed)) break;
    if (/^[-*]\s/.test(line) && !/^\s/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

export function extractEvidenceRows(body) {
  const source = body ?? "";
  const rows = new Map();
  const matches = [];
  for (const match of source.matchAll(MARKER_RE)) {
    const start = match.index;
    matches.push({
      id: match[1].toLowerCase(),
      start,
      end: start + match[0].length,
    });
  }

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const sliceEnd = next ? next.start : source.length;
    const rowText = boundRowBlock(source.slice(current.end, sliceEnd));
    if (!rows.has(current.id) || rowText.length > 0) {
      rows.set(current.id, rowText);
    }
  }
  return rows;
}

export function evaluatePrEvidence(
  body,
  requiredRows = REQUIRED_EVIDENCE_ROWS,
  options = {},
) {
  const rows = extractEvidenceRows(body ?? "");
  const surfaceArtifactsRequired =
    requiresSurfaceArtifacts(options.labels) ||
    requiresSurfaceArtifactsFromFiles(options.changedFiles);
  const findings = requiredRows.map(({ id, label }) => {
    if (!rows.has(id)) return { id, label, status: "missing" };
    const rowText = rows.get(id);
    if (rowText.length === 0) return { id, label, status: "blank" };
    const artifactRequired =
      surfaceArtifactsRequired && SURFACE_ARTIFACT_ROW_IDS.includes(id);
    // Visual rows on a surface PR demand REAL media (attachment/embed/media
    // URL) — a link to the PR page or a /checks tab is not a screenshot.
    if (artifactRequired && !hasVisualArtifactReference(rowText)) {
      return { id, label, status: "artifact-required" };
    }
    return {
      id,
      label,
      status:
        artifactRequired || isRowSatisfied(rowText) ? "ok" : "blank",
    };
  });
  if (surfaceArtifactsRequired && !hasOcrEvidenceReference(rows)) {
    findings.push({ ...SURFACE_OCR_EVIDENCE_ROW, status: "ocr-required" });
  }

  return {
    ok: findings.every((finding) => finding.status === "ok"),
    findings,
  };
}

function readBody(args) {
  const idx = args.indexOf("--body-file");
  if (idx !== -1) {
    const file = args[idx + 1];
    if (!file) {
      console.error("--body-file requires a path argument");
      process.exit(2);
    }
    return readFileSync(file, "utf8");
  }

  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readChangedFiles(args) {
  const idx = args.indexOf("--changed-files-file");
  if (idx === -1) return [];

  const file = args[idx + 1];
  if (!file) {
    console.error("--changed-files-file requires a path argument");
    process.exit(2);
  }
  return parseChangedFiles(readFileSync(file, "utf8"));
}

function usage() {
  console.log(`Usage: node scripts/check-pr-evidence.mjs [options]

Options:
  --body-file <path>  Read the PR body from a file (default: stdin).
  --labels <labels>   Comma-separated PR labels; ui/frontend/native require
                      concrete screenshot/video artifacts and linked OCR proof.
  --changed-files-file <path>
                      Reject committed files under retired repo evidence paths,
                      AND require concrete screenshot/video/OCR artifacts when a
                      rendered-UI source file is in the diff (labels optional).
  --json              Print machine-readable findings JSON.
  --self-test         Run the planted-fixture self-check.
  --help, -h          Show this help.
`);
}

function buildFixtureBody(overrides = {}) {
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

function runSelfTest() {
  const failures = [];

  {
    const { ok } = evaluatePrEvidence(buildFixtureBody());
    if (!ok) failures.push("all-filled fixture should pass");
  }

  {
    const { ok, findings } = evaluatePrEvidence(
      buildFixtureBody({
        "backend-logs":
          "- [ ] Backend logs show the real code path firing end to end, or are marked `N/A - <reason>`.",
      }),
    );
    const blank = findings.find((finding) => finding.id === "backend-logs");
    if (ok) failures.push("blank fixture should fail");
    if (blank?.status !== "blank") {
      failures.push("blank row should be reported blank");
    }
  }

  {
    const { ok, findings } = evaluatePrEvidence(
      buildFixtureBody({
        "backend-logs": "- [x] Backend logs attached.",
      }),
    );
    const blank = findings.find((finding) => finding.id === "backend-logs");
    if (ok) failures.push("checked-without-artifact fixture should fail");
    if (blank?.status !== "blank") {
      failures.push("checked-without-artifact row should be reported blank");
    }
  }

  {
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - not applicable to this change\`.`,
    ).join("\n\n");
    const { ok } = evaluatePrEvidence(body);
    if (!ok) failures.push("all-N/A-with-reason fixture should pass");
  }

  {
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - not applicable to this change\`.`,
    ).join("\n\n");
    const { ok, findings } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      labels: "ui",
    });
    if (ok) failures.push("ui-labeled all-N/A fixture should fail");
    const screenshots = findings.filter((finding) =>
      SURFACE_ARTIFACT_ROW_IDS.includes(finding.id),
    );
    if (screenshots.some((finding) => finding.status !== "artifact-required")) {
      failures.push(
        "ui-labeled screenshot/video rows should require artifacts",
      );
    }
    const ocr = findings.find((finding) => finding.id === "ocr-review");
    if (ocr?.status !== "ocr-required") {
      failures.push("ui-labeled evidence should require OCR proof");
    }
  }

  {
    const body = REQUIRED_EVIDENCE_ROWS.map(
      ({ id }) =>
        `<!-- evidence-row:${id} -->\n- [ ] row \`N/A - not applicable to this change\`.`,
    ).join("\n\n");
    const { ok, findings } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
      changedFiles: ["packages/ui/src/components/Foo.tsx"],
    });
    if (ok) {
      failures.push("UI-file diff with all-N/A rows should fail (no labels)");
    }
    if (
      findings.find((finding) => finding.id === "before-screenshots")
        ?.status !== "artifact-required"
    ) {
      failures.push("UI-file diff should require screenshot artifacts");
    }
  }

  {
    const { ok } = evaluatePrEvidence(buildFixtureBody(), REQUIRED_EVIDENCE_ROWS, {
      changedFiles: [
        "packages/ui/src/components/Foo.test.tsx",
        "packages/app-core/src/services/thing.ts",
        "packages/ui/src/components/Foo.stories.tsx",
      ],
    });
    if (!ok) {
      failures.push(
        "test/story/server-only diff should not trigger surface artifacts",
      );
    }
  }

  {
    const { ok } = evaluatePrEvidence(
      buildFixtureBody({ "backend-logs": "- [ ] Backend logs N/A" }),
    );
    if (ok) failures.push("bare N/A should fail");
  }

  {
    const { ok, findings } = evaluatePrEvidence(
      buildFixtureBody({
        "backend-logs": `- [ ] Backend logs: ${RETIRED_REPO_EVIDENCE_PATH}/13676-backend.txt`,
      }),
    );
    const backend = findings.find((finding) => finding.id === "backend-logs");
    if (ok) failures.push("retired repo evidence-only row should fail");
    if (backend?.status !== "blank") {
      failures.push("retired repo evidence-only row should be reported blank");
    }
  }

  {
    const retired = findRetiredRepoEvidenceFiles([
      "packages/app/test-results/report.json",
      `${RETIRED_REPO_EVIDENCE_PATH}/13676-backend.txt`,
    ]);
    if (retired.length !== 1) {
      failures.push("retired repo evidence changed file should be rejected");
    }
  }

  {
    const body = REQUIRED_EVIDENCE_ROWS.slice(1)
      .map(
        ({ id }) =>
          `<!-- evidence-row:${id} -->\n- [ ] N/A - covered elsewhere`,
      )
      .join("\n\n");
    const { ok, findings } = evaluatePrEvidence(body);
    const missing = findings.find(
      (finding) => finding.id === "before-screenshots",
    );
    if (ok) failures.push("missing-marker fixture should fail");
    if (missing?.status !== "missing") {
      failures.push("absent row should be reported missing");
    }
  }

  if (failures.length > 0) {
    console.error("check-pr-evidence self-test FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("check-pr-evidence self-test passed (11 cases).");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const body = readBody(args);
  const labelsIdx = args.indexOf("--labels");
  const labels = labelsIdx === -1 ? "" : (args[labelsIdx + 1] ?? "");
  const changedFiles = readChangedFiles(args);
  const retiredEvidenceFiles = findRetiredRepoEvidenceFiles(changedFiles);
  const { ok, findings } = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
    labels,
    changedFiles,
  });
  const allOk = ok && retiredEvidenceFiles.length === 0;

  if (args.includes("--json")) {
    console.log(
      JSON.stringify({ ok: allOk, findings, retiredEvidenceFiles }, null, 2),
    );
  } else {
    for (const finding of findings) {
      const symbol = finding.status === "ok" ? "ok  " : "FAIL";
      console.log(
        `  [${symbol}] ${finding.label} (${finding.id}): ${finding.status}`,
      );
    }
    if (retiredEvidenceFiles.length > 0) {
      console.log("  [FAIL] Retired repo evidence files:");
      for (const file of retiredEvidenceFiles) console.log(`    - ${file}`);
    }
  }

  if (!allOk) {
    const bad = findings.filter((finding) => finding.status !== "ok");
    console.error(
      `\nEvidence gate FAILED: ${bad.length} row(s) blank or missing, ${retiredEvidenceFiles.length} retired repo evidence file(s) changed. ` +
        "Attach the artifact inline (GitHub attachment URL) or write `N/A - <reason>` on each row. " +
        "For ui/frontend/native PRs, before/after screenshots and walkthrough video require concrete inline artifact links. " +
        "Surface PRs also require linked OCR evidence from the visual review/audit. " +
        "Retired repo-local evidence paths do not count as evidence and must not be committed.",
    );
    process.exit(1);
  }
  console.log("\nEvidence gate passed: all required rows satisfied.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
