#!/usr/bin/env node
/**
 * Mechanical PR evidence gate for the evidence rows in the pull request
 * template. The template keeps stable HTML markers above each required row so
 * this checker can ignore row prose churn while still failing closed when a row
 * is blank, checkbox-only, or removed.
 */

import { createHash } from "node:crypto";
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

export function hasMatchingEvidenceHead(body, headSha) {
  if (!/^[a-f0-9]{40}$/i.test(String(headSha ?? ""))) return false;
  const matches = [
    ...String(body ?? "").matchAll(
      /<!--\s*evidence-head:([a-f0-9]{40})\s*-->/gi,
    ),
  ];
  return (
    matches.length === 1 &&
    matches[0][1].toLowerCase() === String(headSha).toLowerCase()
  );
}

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
  /(^|\/)(packages\/(app|ui|tui|homepage)|apps\/app|packages\/cloud\/frontend)\//i;
const SURFACE_VISUAL_EXT_RE = /\.(tsx|jsx|css|scss|sass|less|svg|html|vue)$/i;
const SURFACE_NON_VISUAL_RE =
  /(\.(test|spec|stories|story|bench)\.|\.d\.ts$|(^|\/)(__tests__|__e2e__|__mocks__|__fixtures__|test|tests|e2e|stories)\/)/i;

/**
 * True when any changed file is a rendered-UI source file (see `SURFACE_PATH_RE`
 * rationale). Backslash paths from a Windows runner are normalized so the same
 * diff classifies identically on either OS.
 */
export function requiresSurfaceArtifactsFromFiles(files) {
  return surfaceFiles(files).length > 0;
}

/** The rendered-UI source files within a changed-file list. */
export function surfaceFiles(files) {
  return parseChangedFiles(files)
    .map((raw) => raw.replaceAll("\\", "/"))
    .filter(
      (file) =>
        SURFACE_PATH_RE.test(file) &&
        SURFACE_VISUAL_EXT_RE.test(file) &&
        !SURFACE_NON_VISUAL_RE.test(file),
    );
}

/**
 * A "before" screenshot is impossible when the ENTIRE touched UI surface is new
 * — every rendered-UI file in the diff was ADDED, none modified. In that case
 * the before-screenshots row may be an honest `N/A - <reason>` instead of
 * media. Determined mechanically from the added-files list (`git diff
 * --diff-filter=A`), never from the reason text, so it cannot be gamed by
 * prose.
 */
export function beforeScreenshotImpossible(changedFiles, addedFiles) {
  const surface = surfaceFiles(changedFiles);
  if (surface.length === 0) return false;
  const added = new Set(surfaceFiles(addedFiles));
  return surface.every((file) => added.has(file));
}
const OCR_EVIDENCE_RE =
  /\bOCR\b|ocr-triage|mvp:visual-verify|audit:app:verify|tesseract|text readout/i;

const MARKER_RE = /<!--\s*evidence-row:([a-z0-9-]+)\s*-->/gi;
const RETIRED_REPO_EVIDENCE_PATH = [
  ".github",
  ["issue", "evidence"].join("-"),
].join("/");

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
    // OCR proof must name the review method and point at an accepted uploaded
    // report. A screenshot whose alt text merely says "OCR" is not a readout.
    if (OCR_EVIDENCE_RE.test(rowText) && hasEvidenceFileReference(rowText)) {
      return true;
    }
  }
  return false;
}

export function hasNaWithReason(text) {
  const match = text.match(/\bN\/?A\b\s*[-:\u2013\u2014]\s*(\S[\s\S]*?)$/im);
  if (!match) return false;
  const reason = match[1]
    .replace(/[`*_]+/g, "")
    .replace(/[.)\]}]+$/g, "")
    .trim();
  if (reason.length < 12 || /^<[^>]*>[.\s]*$/.test(reason)) return false;
  if (/<(?:reason|explanation|details)>/i.test(reason)) return false;
  if (/https?:\/\//i.test(reason)) return false;
  return (reason.match(/[a-z0-9][a-z0-9'.-]*/gi) ?? []).length >= 3;
}

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const EVIDENCE_FILE_EXTENSIONS = new Set([
  ".csv",
  ".html",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".txt",
]);
const UUID_PATH =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const USER_ATTACHMENT_PATH_RE = new RegExp(
  `^/user-attachments/assets/${UUID_PATH}$`,
  "i",
);
const LEGACY_REPO_ASSET_PATH_RE = new RegExp(
  `^/elizaOS/eliza/assets/[0-9]+/${UUID_PATH}$`,
  "i",
);
const PR_EVIDENCE_RELEASE_PATH_RE =
  /^\/elizaOS\/eliza\/releases\/download\/pr-evidence(?:-[1-9][0-9]*)?\/([^/]+)$/i;
// GitHub's uploader mints `/user-attachments/assets/<uuid>` for media and
// `/user-attachments/files/<id>/<name>` for text formats (.log/.txt/.json/…).
// Fork contributors cannot upload to the pr-evidence release (push access
// required), so the files path is the only first-party route for attaching a
// document artifact (#17600). Unlike the opaque assets path, the filename here
// carries a real extension, so acceptance is gated on the evidence-file
// allowlist below — archives and binaries stay untrusted.
const USER_ATTACHMENT_FILE_PATH_RE =
  /^\/user-attachments\/files\/[0-9]+\/[^/]+$/i;
const LEGACY_USER_IMAGE_PATH_RE = /^\/[0-9]+\/[^/].+$/;

function extensionFromPath(pathname) {
  let filename;
  try {
    filename = decodeURIComponent(pathname.split("/").at(-1) ?? "");
  } catch {
    return null;
  }
  const match = filename.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function urlReferences(text) {
  const source = String(text ?? "");
  const references = [];
  const seen = new Set();
  const add = (rawUrl, presentation) => {
    const normalized = rawUrl.trim().replace(/^<|>$/g, "");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      references.push({ url: normalized, presentation });
    }
  };

  for (const match of source.matchAll(
    /(!?)\[[^\]]*\]\(\s*<?(https:\/\/[^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/gi,
  )) {
    add(match[2], match[1] === "!" ? "image" : "link");
  }
  for (const match of source.matchAll(
    /<(img|video|source)\b[^>]*\bsrc\s*=\s*["'](https:\/\/[^"']+)["'][^>]*>/gi,
  )) {
    add(match[2], match[1].toLowerCase() === "img" ? "image" : "video");
  }
  for (const match of source.matchAll(/https:\/\/[^\s<>"'`)\]]+/gi)) {
    add(match[0].replace(/[.,;:!?]+$/g, ""), "link");
  }
  return references;
}

function trustedArtifact(reference) {
  let url;
  try {
    url = new URL(reference.url);
  } catch {
    // error-policy:J3 URL parsing is an untrusted PR-body boundary; malformed
    // values are explicitly invalid evidence.
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const extension = extensionFromPath(url.pathname);
  if (extension === null || extension === ".zip") return null;
  const normalizedReference = {
    ...reference,
    url: url.href,
    identity: `${url.origin}${url.pathname}`,
  };
  if (hostname === "github.com") {
    if (USER_ATTACHMENT_PATH_RE.test(url.pathname)) {
      return {
        extension,
        kind: "opaque-upload",
        ...normalizedReference,
      };
    }
    if (LEGACY_REPO_ASSET_PATH_RE.test(url.pathname)) {
      return {
        extension,
        kind: "opaque-upload",
        ...normalizedReference,
      };
    }
    // A distinct kind, NOT opaque-upload: visual rows treat linked opaque
    // uploads as media, and a .log file must never satisfy a video row.
    if (
      USER_ATTACHMENT_FILE_PATH_RE.test(url.pathname) &&
      EVIDENCE_FILE_EXTENSIONS.has(extension)
    ) {
      return {
        extension,
        kind: "file-upload",
        ...normalizedReference,
      };
    }
    if (PR_EVIDENCE_RELEASE_PATH_RE.test(url.pathname)) {
      return {
        extension,
        kind: "release-upload",
        ...normalizedReference,
      };
    }
    return null;
  }
  if (
    hostname === "user-images.githubusercontent.com" &&
    LEGACY_USER_IMAGE_PATH_RE.test(url.pathname) &&
    IMAGE_EXTENSIONS.has(extension)
  ) {
    return {
      extension,
      kind: "legacy-image",
      ...normalizedReference,
    };
  }
  return null;
}

function trustedArtifacts(text) {
  const artifacts = new Map();
  for (const reference of urlReferences(text)) {
    const artifact = trustedArtifact(reference);
    if (!artifact) continue;
    const existing = artifacts.get(artifact.identity);
    if (
      !existing ||
      (existing.presentation === "link" && artifact.presentation !== "link")
    ) {
      artifacts.set(artifact.identity, artifact);
    }
  }
  return [...artifacts.values()];
}

export function hasArtifactReference(text) {
  return trustedArtifacts(text).length > 0;
}

function artifactCanBeEvidenceFile({ extension, kind, presentation }) {
  return (
    (kind === "opaque-upload" && presentation === "link") ||
    EVIDENCE_FILE_EXTENSIONS.has(extension)
  );
}

export function hasEvidenceFileReference(text) {
  return trustedArtifacts(text).some(artifactCanBeEvidenceFile);
}

// `\b` treats punctuation inside commands, paths, and member names as a word
// boundary. A marker must therefore be separated from an identifier on both
// sides; a dot only joins the following token when it actually starts an
// extension/member, so sentence-ending punctuation remains detectable.
const NON_REAL_EVIDENCE_RE =
  /(?<![\w/\\@:.-])(?:placeholder|example output|logs? here|todo|tbd|fabricated|invented|fake|mocks?|fixtures?|synthetic|dummy)(?![\w/\\@-]|:[\w-]|\.[\w-])/i;

function hasSubstantiveInlineLog(text) {
  const source = String(text ?? "");
  for (const details of source.matchAll(
    /<details\b[^>]*>([\s\S]*?)<\/details>/gi,
  )) {
    const block = details[1];
    const summary =
      block.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? "";
    if (
      !/\b(logs?|console|network|request|response|output|trace)\b/i.test(
        summary,
      )
    ) {
      continue;
    }
    for (const fence of block.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      const content = fence[1].trim();
      const lines = content.split(/\r?\n/).filter((line) => line.trim());
      if (
        content.length >= 80 &&
        lines.length >= 3 &&
        !NON_REAL_EVIDENCE_RE.test(content) &&
        /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\b(?:INFO|WARN|ERROR|DEBUG)\b|HTTP\/[12](?:\.\d)?\s+\d{3}|\bstatus(?:Code)?["'=:\s]+\d{3}\b|^\s*[{[])/im.test(
          content,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Minimum substance for a pasted transcript to count as evidence. */
const INLINE_TRANSCRIPT_MIN_LINES = 3;
const INLINE_TRANSCRIPT_MIN_CHARS = 120;

function inlineTranscriptMeasurements(text) {
  const source = String(text ?? "");
  const blocks = [
    ...source.matchAll(/<details[\s\S]*?<\/details>/gi),
    ...source.matchAll(/<pre[\s\S]*?<\/pre>/gi),
    ...source.matchAll(/(?:```[\s\S]*?```|~~~[\s\S]*?~~~)/g),
  ].map((match) => match[0]);

  return blocks.flatMap((block) => {
    const content = block
      // A <summary> is a caption, not evidence — it must not carry the block.
      .replace(/<summary[\s\S]*?<\/summary>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/^\s*(?:`{3,}|~{3,})[^\r\n]*$/gm, " ");
    if (NON_REAL_EVIDENCE_RE.test(content)) return [];
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return [{ lines: lines.length, chars: lines.join("").length }];
  });
}

function inlineTranscriptMeetsFloor({ lines, chars }) {
  return (
    lines >= INLINE_TRANSCRIPT_MIN_LINES && chars >= INLINE_TRANSCRIPT_MIN_CHARS
  );
}

/**
 * True when the row carries a pasted log/transcript body rather than a link to
 * one. CONTRIBUTING.md § Evidence and the root AGENTS.md both prescribe "long
 * logs in a `<details>` block", so a row that follows the documented standard
 * must satisfy the gate — requiring a URL for every non-visual row contradicts
 * the standard the gate cites and reports a real pasted transcript as `blank`.
 *
 * Only the container's own text counts: tags are stripped and the remainder must
 * clear a line and character floor, so `<details></details>` or a one-line
 * "logs attached" still fails. This never relaxes the visual rows — a surface PR
 * reaches `hasVisualArtifactReference` first and returns `artifact-required`
 * before this is consulted, so screenshots and video still demand real media.
 */
export function hasInlineTranscriptEvidence(text) {
  return inlineTranscriptMeasurements(text).some(inlineTranscriptMeetsFloor);
}

/**
 * Explain a pasted transcript that just missed the floor.
 *
 * A row holding a real code block is a different author mistake from an empty
 * one: they followed CONTRIBUTING.md § Evidence and landed under a threshold.
 * Reporting a bare `blank` there sends them to upload an artifact instead of
 * pasting four more lines. Returns null when no block is present, so a genuinely
 * empty row keeps its plain `blank`.
 */
export function describeInlineTranscriptShortfall(text) {
  let best = null;
  for (const measurement of inlineTranscriptMeasurements(text)) {
    // Report the closest attempt rather than whichever block appears first.
    if (
      best === null ||
      measurement.lines + measurement.chars > best.lines + best.chars
    ) {
      best = measurement;
    }
  }
  if (best === null || inlineTranscriptMeetsFloor(best)) return null;

  const missed = [];
  if (best.lines < INLINE_TRANSCRIPT_MIN_LINES) {
    missed.push(`${best.lines} line(s), needs ${INLINE_TRANSCRIPT_MIN_LINES}`);
  }
  if (best.chars < INLINE_TRANSCRIPT_MIN_CHARS) {
    missed.push(
      `${best.chars} character(s), needs ${INLINE_TRANSCRIPT_MIN_CHARS}`,
    );
  }
  if (missed.length === 0) return null;
  return `pasted transcript is under the floor (${missed.join("; ")})`;
}

function fencedBlockDelimiter(line) {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return {
    character: match[1][0],
    length: match[1].length,
    remainder: match[2],
  };
}

function closesFencedBlock(line, fence) {
  const delimiter = fencedBlockDelimiter(line);
  return (
    delimiter !== null &&
    delimiter.character === fence.character &&
    delimiter.length >= fence.length &&
    delimiter.remainder.trim() === ""
  );
}

function substantiveTrajectoryValue(value, minimumLength) {
  const serialized =
    typeof value === "string" ? value.trim() : JSON.stringify(value);
  if (!serialized || serialized.length < minimumLength) return false;
  const semantic = serialized.replace(/[^a-z0-9]+/gi, "").toLowerCase();
  return semantic.length >= minimumLength && new Set(semantic).size >= 4;
}

function hasMeaningfulTrajectoryKey(value, acceptedKeys, minimumLength) {
  if (Array.isArray(value)) {
    return value.some((entry) =>
      hasMeaningfulTrajectoryKey(entry, acceptedKeys, minimumLength),
    );
  }
  if (!value || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    if (acceptedKeys.has(normalizedKey)) {
      if (substantiveTrajectoryValue(entry, minimumLength)) return true;
    }
    if (hasMeaningfulTrajectoryKey(entry, acceptedKeys, minimumLength)) {
      return true;
    }
  }
  return false;
}

function hasTrajectorySemantics(value) {
  return (
    hasMeaningfulTrajectoryKey(value, new Set(["provider"]), 4) &&
    hasMeaningfulTrajectoryKey(value, new Set(["model", "modelid"]), 4) &&
    hasMeaningfulTrajectoryKey(
      value,
      new Set(["input", "messages", "prompt", "request"]),
      8,
    ) &&
    hasMeaningfulTrajectoryKey(
      value,
      new Set(["completion", "events", "output", "response", "steps"]),
      8,
    )
  );
}

function parseStructuredTrajectory(text) {
  const content = text.trim();
  if (content.length < INLINE_TRANSCRIPT_MIN_CHARS) return null;
  try {
    const parsed = JSON.parse(content);
    return meaningfulJson(parsed) ? parsed : null;
  } catch {
    // error-policy:J3 pasted trajectory JSON is untrusted input. JSONL is the
    // native alternative, and every non-empty line must be a complete record;
    // mixed prose and JSON is not machine-verifiable.
  }
  const records = parseJsonLines(content, true);
  return records && records.length >= 2 ? records : null;
}

/** True only for pasted JSON/JSONL carrying model, input, and output records. */
export function hasSubstantiveInlineTrajectory(text) {
  const source = String(text ?? "");
  const blocks = [
    ...source.matchAll(/<details[\s\S]*?<\/details>/gi),
    ...source.matchAll(/<pre[\s\S]*?<\/pre>/gi),
    ...source.matchAll(/```[\s\S]*?```/g),
  ].map((match) => match[0]);
  return blocks.some((block) => {
    const content = block
      .replace(/<summary[\s\S]*?<\/summary>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/```[^\n]*\n/g, "")
      .replace(/```/g, "")
      .trim();
    if (NON_REAL_EVIDENCE_RE.test(content)) return false;
    const parsed = parseStructuredTrajectory(content);
    return parsed !== null && hasTrajectorySemantics(parsed);
  });
}

/**
 * Accepts only media uploaded to GitHub's attachment hosts or the repository's
 * canonical evidence release. Opaque GitHub upload URLs must use image markup
 * for screenshot rows; video rows accept the bare URL form GitHub emits.
 */
export function hasVisualArtifactReference(text, expected = "media") {
  return trustedArtifacts(text).some((artifact) => {
    const image =
      IMAGE_EXTENSIONS.has(artifact.extension) ||
      (artifact.kind === "opaque-upload" && artifact.presentation === "image");
    const video =
      VIDEO_EXTENSIONS.has(artifact.extension) ||
      (artifact.kind === "opaque-upload" && artifact.presentation !== "image");
    if (expected === "image") return image;
    if (expected === "video") return video;
    return image || video;
  });
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
  return (
    hasNaWithReason(rowText) ||
    hasArtifactReference(rowText) ||
    hasInlineTranscriptEvidence(rowText)
  );
}

export function isRowSatisfiedForContext(
  rowText,
  { artifactRequired = false } = {},
) {
  if (artifactRequired) return hasArtifactReference(rowText);
  return isRowSatisfied(rowText);
}

function isEvidenceRowSatisfied(id, rowText) {
  if (hasNaWithReason(rowText)) return true;
  if (id === "before-screenshots" || id === "after-screenshots") {
    return hasVisualArtifactReference(rowText, "image");
  }
  if (id === "walkthrough-video") {
    return hasVisualArtifactReference(rowText, "video");
  }
  if (id === "backend-logs" || id === "frontend-logs") {
    return (
      hasEvidenceFileReference(rowText) ||
      hasSubstantiveInlineLog(rowText) ||
      hasInlineTranscriptEvidence(rowText)
    );
  }
  if (id === "llm-trajectory") {
    return (
      hasEvidenceFileReference(rowText) ||
      hasSubstantiveInlineTrajectory(rowText)
    );
  }
  return hasArtifactReference(rowText) || hasInlineTranscriptEvidence(rowText);
}

export function boundRowBlock(block) {
  const lines = block.split(/\r?\n/);
  const out = [];
  let started = false;
  let detailsDepth = 0;
  let fence = null;
  let fenceStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!started) {
      if (line.trim() === "") continue;
      started = true;
      out.push(line);
      const delimiter = fencedBlockDelimiter(line);
      if (delimiter) {
        fence = delimiter;
        fenceStart = out.length - 1;
      }
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "") {
      if (detailsDepth > 0 || fence !== null) {
        out.push(line);
        continue;
      }
      const next = lines.slice(index + 1).find((candidate) => candidate.trim());
      if (
        next &&
        (/^<details\b/i.test(next.trim()) ||
          fencedBlockDelimiter(next) !== null)
      ) {
        out.push(line);
        continue;
      }
      break;
    }
    if (fence === null && detailsDepth === 0 && /^#/.test(trimmed)) break;
    if (fence === null && /<!--\s*evidence-row:/i.test(trimmed)) break;
    if (
      fence === null &&
      detailsDepth === 0 &&
      /^[-*]\s/.test(line) &&
      !/^\s/.test(line)
    ) {
      break;
    }
    out.push(line);
    if (fence !== null) {
      if (closesFencedBlock(line, fence)) {
        fence = null;
        fenceStart = -1;
      }
      continue;
    }
    const delimiter = fencedBlockDelimiter(line);
    if (delimiter) {
      fence = delimiter;
      fenceStart = out.length - 1;
      continue;
    }
    detailsDepth += (line.match(/<details\b/gi) ?? []).length;
    detailsDepth -= (line.match(/<\/details>/gi) ?? []).length;
    detailsDepth = Math.max(0, detailsDepth);
  }
  // An unterminated fence must not absorb headings or links below the row and
  // accidentally turn unrelated prose into evidence.
  const bounded = fence === null ? out : out.slice(0, fenceStart);
  return bounded.join("\n").trim();
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

function duplicateArtifactsByRow(rows, requiredRows) {
  const owners = new Map();
  for (const { id } of requiredRows) {
    const rowText = rows.get(id);
    if (rowText === undefined) continue;
    for (const artifact of trustedArtifacts(rowText)) {
      const record = owners.get(artifact.identity) ?? {
        rows: new Set(),
        url: artifact.url,
      };
      record.rows.add(id);
      owners.set(artifact.identity, record);
    }
  }

  const duplicates = new Map();
  for (const { rows: rowIds, url } of owners.values()) {
    if (rowIds.size < 2) continue;
    for (const id of rowIds) {
      const rowDuplicates = duplicates.get(id) ?? [];
      rowDuplicates.push({ rowIds: [...rowIds], url });
      duplicates.set(id, rowDuplicates);
    }
  }
  return duplicates;
}

export function evaluatePrEvidence(
  body,
  requiredRows = REQUIRED_EVIDENCE_ROWS,
  options = {},
) {
  const source = String(body ?? "");
  const rows = extractEvidenceRows(source);
  const markerCounts = new Map();
  for (const match of source.matchAll(MARKER_RE)) {
    const id = match[1].toLowerCase();
    markerCounts.set(id, (markerCounts.get(id) ?? 0) + 1);
  }
  // When a changed-file list is available, path detection is the sole surface
  // trigger: the auto-labeler applies `ui` to ANY packages/ui path, so the
  // label alone forces screenshots onto non-visual .ts changes. The label
  // trigger survives only for label-only invocations (no file list), where it
  // is the best signal available.
  const surfaceArtifactsRequired =
    parseChangedFiles(options.changedFiles).length > 0
      ? requiresSurfaceArtifactsFromFiles(options.changedFiles)
      : requiresSurfaceArtifacts(options.labels);
  // A wholly-new surface (every touched UI file was ADDED) has no "before"
  // state to photograph; that one row may be N/A-with-reason.
  const beforeNaAllowed = beforeScreenshotImpossible(
    options.changedFiles,
    options.addedFiles,
  );
  const rowsCheckedForDuplicates = [
    ...requiredRows,
    ...(surfaceArtifactsRequired || rows.has(SURFACE_OCR_EVIDENCE_ROW.id)
      ? [SURFACE_OCR_EVIDENCE_ROW]
      : []),
  ].filter(
    (row, index, allRows) =>
      allRows.findIndex((candidate) => candidate.id === row.id) === index,
  );
  const duplicateArtifacts = duplicateArtifactsByRow(
    rows,
    rowsCheckedForDuplicates,
  );
  const findings = requiredRows.map(({ id, label }) => {
    const rowDuplicates = duplicateArtifacts.get(id);
    if (rowDuplicates) {
      const details = rowDuplicates.map(({ rowIds, url }) => {
        const otherRows = rowIds.filter((rowId) => rowId !== id).join(", ");
        return `${url} is also used by ${otherRows}`;
      });
      return {
        id,
        label,
        status: "duplicate-artifact",
        detail: details.join("; "),
      };
    }
    if (!rows.has(id)) return { id, label, status: "missing" };
    if (markerCounts.get(id) !== 1) {
      return { id, label, status: "duplicate" };
    }
    const rowText = rows.get(id);
    if (rowText.length === 0) return { id, label, status: "blank" };
    const artifactRequired =
      surfaceArtifactsRequired &&
      SURFACE_ARTIFACT_ROW_IDS.includes(id) &&
      !(
        id === "before-screenshots" &&
        beforeNaAllowed &&
        hasNaWithReason(rowText)
      );
    // Visual rows on a surface PR demand REAL media (attachment/embed/media
    // URL) — a link to the PR page or a /checks tab is not a screenshot.
    const expectedMedia = id === "walkthrough-video" ? "video" : "image";
    if (
      artifactRequired &&
      !hasVisualArtifactReference(rowText, expectedMedia)
    ) {
      return { id, label, status: "artifact-required" };
    }
    if (artifactRequired || isEvidenceRowSatisfied(id, rowText)) {
      return { id, label, status: "ok" };
    }
    const shortfall = describeInlineTranscriptShortfall(rowText);
    return shortfall
      ? { id, label, status: "blank", detail: shortfall }
      : { id, label, status: "blank" };
  });
  if (surfaceArtifactsRequired) {
    const { id, label } = SURFACE_OCR_EVIDENCE_ROW;
    const rowText = rows.get(id);
    const rowDuplicates = duplicateArtifacts.get(id);
    if (rowDuplicates) {
      findings.push({
        id,
        label,
        status: "duplicate-artifact",
        detail: rowDuplicates
          .map(
            ({ rowIds, url }) =>
              `${url} is also used by ${rowIds.filter((rowId) => rowId !== id).join(", ")}`,
          )
          .join("; "),
      });
    } else if (rowText === undefined) {
      findings.push({ ...SURFACE_OCR_EVIDENCE_ROW, status: "ocr-required" });
    } else if (markerCounts.get(id) !== 1) {
      findings.push({ ...SURFACE_OCR_EVIDENCE_ROW, status: "ocr-required" });
    } else if (
      rowText.length === 0 ||
      !OCR_EVIDENCE_RE.test(rowText) ||
      !hasEvidenceFileReference(rowText)
    ) {
      findings.push({ ...SURFACE_OCR_EVIDENCE_ROW, status: "ocr-required" });
    } else {
      findings.push({ ...SURFACE_OCR_EVIDENCE_ROW, status: "ok" });
    }
  }

  return {
    ok: findings.every((finding) => finding.status === "ok"),
    findings,
  };
}

const ARTIFACT_READ_LIMIT_BYTES = 64 * 1024;
const DOCUMENT_READ_LIMIT_BYTES = 2 * 1024 * 1024;
const MIN_IMAGE_BYTES = 1024;
const MIN_VIDEO_BYTES = 16 * 1024;
const MIN_SCREENSHOT_WIDTH = 320;
const MIN_SCREENSHOT_HEIGHT = 180;
const DEFAULT_ARTIFACT_CONCURRENCY = 4;
const DEFAULT_ARTIFACT_TIMEOUT_MS = 10_000;
const MAX_ARTIFACT_REDIRECTS = 4;
const MAX_CONTENT_DIGEST_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_ROW = 8;
export const MAX_ARTIFACTS_TOTAL = 32;
const TRUSTED_ARTIFACT_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
  "objects.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "user-images.githubusercontent.com",
]);
const UNRELIABLE_CONTENT_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);
const ISO_BMFF_VIDEO_BRANDS = new Set([
  "3g2a",
  "3g2b",
  "3gp4",
  "3gp5",
  "3gp6",
  "M4V ",
  "M4VH",
  "M4VP",
  "MSNV",
  "avc1",
  "cmfc",
  "cmfv",
  "dash",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "isom",
  "mp41",
  "mp42",
  "qt  ",
]);
const TEXT_DECODER = new TextDecoder();
const NON_REAL_DOCUMENT_RE =
  /^\s*(?:(?:this\s+)?(?:artifact|evidence)\s+(?:is\s+|[:=-]\s*))(?:a\s+)?(?:placeholder|fabricated|invented|dummy|fake|synthetic|mock|fixture)\b/im;

function expectedArtifactKind(rowId, artifact, rowText) {
  if (rowId === "before-screenshots" || rowId === "after-screenshots") {
    return "image";
  }
  if (rowId === "walkthrough-video") return "video";
  if (rowId === SURFACE_OCR_EVIDENCE_ROW.id) return "document";
  if (
    rowId === "backend-logs" ||
    rowId === "frontend-logs" ||
    rowId === "llm-trajectory"
  ) {
    return "document";
  }
  if (
    rowId === "domain-artifacts" &&
    OCR_EVIDENCE_RE.test(rowText) &&
    artifactCanBeEvidenceFile(artifact)
  ) {
    return "document";
  }
  if (IMAGE_EXTENSIONS.has(artifact.extension)) return "image";
  if (VIDEO_EXTENSIONS.has(artifact.extension)) return "video";
  if (EVIDENCE_FILE_EXTENSIONS.has(artifact.extension)) return "document";
  if (artifact.presentation === "image") return "image";
  if (artifact.presentation === "video") return "video";
  return null;
}

function ascii(bytes, start, end) {
  return TEXT_DECODER.decode(bytes.subarray(start, end));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function usefulImageDimensions(width, height) {
  return width >= MIN_SCREENSHOT_WIDTH && height >= MIN_SCREENSHOT_HEIGHT;
}

function pngMetadata(bytes, complete) {
  if (
    bytes.length < 41 ||
    ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    )
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const validDepths = new Map([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
  ]);
  let offset = 8;
  let width = 0;
  let height = 0;
  let hasIdat = false;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) {
      if (
        !complete &&
        type === "IDAT" &&
        width > 0 &&
        bytes.length - dataStart >= 256
      ) {
        return { height, kind: "image", width };
      }
      return null;
    }
    if (
      view.getUint32(dataEnd) !== crc32(bytes.subarray(offset + 4, dataEnd))
    ) {
      return null;
    }
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return null;
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      if (
        !usefulImageDimensions(width, height) ||
        validDepths.get(colorType)?.has(bitDepth) !== true ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        ![0, 1].includes(bytes[dataStart + 12])
      ) {
        return null;
      }
    } else if (type === "IHDR") {
      return null;
    } else if (type === "IDAT") {
      if (length === 0) return null;
      hasIdat = true;
    } else if (type === "IEND") {
      if (length !== 0 || !hasIdat || chunkEnd !== bytes.length) return null;
      return { height, kind: "image", width };
    }
    offset = chunkEnd;
  }
  return !complete && hasIdat ? { height, kind: "image", width } : null;
}

function jpegMetadata(bytes, complete) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  let width = 0;
  let height = 0;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (sofMarkers.has(marker)) {
      if (segmentLength < 8) return null;
      height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const components = bytes[offset + 7];
      if (
        ![8, 12].includes(bytes[offset + 2]) ||
        !usefulImageDimensions(width, height) ||
        components < 1 ||
        components > 4 ||
        segmentLength < 8 + components * 3
      ) {
        return null;
      }
    }
    if (marker === 0xda) {
      const scanStart = offset + segmentLength;
      const hasEoi =
        bytes.length >= 2 &&
        bytes[bytes.length - 2] === 0xff &&
        bytes[bytes.length - 1] === 0xd9;
      const scanEnd = complete ? bytes.length - 2 : bytes.length;
      if (width === 0 || scanEnd - scanStart < 256 || (complete && !hasEoi)) {
        return null;
      }
      return { height, kind: "image", width };
    }
    offset += segmentLength;
  }
  return null;
}

function readGifSubBlocks(bytes, start) {
  let offset = start;
  let payloadBytes = 0;
  while (offset < bytes.length) {
    const size = bytes[offset];
    offset += 1;
    if (size === 0) return { complete: true, offset, payloadBytes };
    const available = Math.min(size, bytes.length - offset);
    payloadBytes += available;
    offset += available;
    if (available !== size) {
      return { complete: false, offset, payloadBytes };
    }
  }
  return { complete: false, offset, payloadBytes };
}

function gifMetadata(bytes, complete) {
  if (bytes.length < 14 || !/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) {
    return null;
  }
  const canvasWidth = bytes[6] | (bytes[7] << 8);
  const canvasHeight = bytes[8] | (bytes[9] << 8);
  if (!usefulImageDimensions(canvasWidth, canvasHeight)) return null;
  const globalTableBytes =
    bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 0x07) + 1) : 0;
  let offset = 13 + globalTableBytes;
  let hasImagePayload = false;
  while (offset < bytes.length) {
    const marker = bytes[offset];
    if (marker === 0x3b) {
      return hasImagePayload && offset + 1 === bytes.length
        ? { height: canvasHeight, kind: "image", width: canvasWidth }
        : null;
    }
    if (marker === 0x21) {
      if (offset + 2 > bytes.length) return null;
      const extension = readGifSubBlocks(bytes, offset + 2);
      if (!extension.complete) return null;
      offset = extension.offset;
      continue;
    }
    if (marker !== 0x2c || offset + 10 > bytes.length) return null;
    const left = bytes[offset + 1] | (bytes[offset + 2] << 8);
    const top = bytes[offset + 3] | (bytes[offset + 4] << 8);
    const width = bytes[offset + 5] | (bytes[offset + 6] << 8);
    const height = bytes[offset + 7] | (bytes[offset + 8] << 8);
    if (
      !usefulImageDimensions(width, height) ||
      left + width > canvasWidth ||
      top + height > canvasHeight
    ) {
      return null;
    }
    const localTableBytes =
      bytes[offset + 9] & 0x80 ? 3 * 2 ** ((bytes[offset + 9] & 0x07) + 1) : 0;
    const lzwCodeSizeOffset = offset + 10 + localTableBytes;
    if (lzwCodeSizeOffset >= bytes.length) return null;
    if (bytes[lzwCodeSizeOffset] < 2 || bytes[lzwCodeSizeOffset] > 8) {
      return null;
    }
    const imageData = readGifSubBlocks(bytes, lzwCodeSizeOffset + 1);
    hasImagePayload = imageData.payloadBytes >= 256;
    if (!imageData.complete) {
      return !complete && hasImagePayload
        ? { height: canvasHeight, kind: "image", width: canvasWidth }
        : null;
    }
    offset = imageData.offset;
  }
  return !complete && hasImagePayload
    ? { height: canvasHeight, kind: "image", width: canvasWidth }
    : null;
}

function webpMetadata(bytes, complete) {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredEnd = view.getUint32(4, true) + 8;
  if (
    (complete && declaredEnd !== bytes.length) ||
    declaredEnd < bytes.length
  ) {
    return null;
  }
  let offset = 12;
  let width = 0;
  let height = 0;
  let hasImagePayload = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const paddedEnd = dataEnd + (size % 2);
    const availablePayload = Math.max(
      0,
      Math.min(dataEnd, bytes.length) - dataStart,
    );
    if (type === "VP8X" && availablePayload >= 10) {
      width =
        1 +
        bytes[dataStart + 4] +
        (bytes[dataStart + 5] << 8) +
        (bytes[dataStart + 6] << 16);
      height =
        1 +
        bytes[dataStart + 7] +
        (bytes[dataStart + 8] << 8) +
        (bytes[dataStart + 9] << 16);
    } else if (
      type === "VP8L" &&
      availablePayload >= 5 &&
      bytes[dataStart] === 0x2f
    ) {
      const bits = view.getUint32(dataStart + 1, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      hasImagePayload = availablePayload >= 256;
    } else if (
      type === "VP8 " &&
      availablePayload >= 10 &&
      bytes[dataStart + 3] === 0x9d &&
      bytes[dataStart + 4] === 0x01 &&
      bytes[dataStart + 5] === 0x2a
    ) {
      width = (bytes[dataStart + 6] | (bytes[dataStart + 7] << 8)) & 0x3fff;
      height = (bytes[dataStart + 8] | (bytes[dataStart + 9] << 8)) & 0x3fff;
      hasImagePayload = availablePayload >= 256;
    }
    if (paddedEnd > bytes.length) {
      return !complete &&
        hasImagePayload &&
        usefulImageDimensions(width, height)
        ? { height, kind: "image", width }
        : null;
    }
    offset = paddedEnd;
  }
  return offset === bytes.length &&
    hasImagePayload &&
    usefulImageDimensions(width, height)
    ? { height, kind: "image", width }
    : null;
}

function readIsoBox(bytes, offset, limit, completeContainer) {
  if (offset + 8 > limit) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(offset);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const extended = view.getBigUint64(offset + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(extended);
    headerSize = 16;
  } else if (size === 0) {
    if (!completeContainer) return null;
    size = limit - offset;
  }
  if (size < headerSize || !Number.isSafeInteger(offset + size)) return null;
  const end = offset + size;
  return {
    availableEnd: Math.min(end, limit),
    end,
    payloadStart: offset + headerSize,
    start: offset,
    truncated: end > limit,
    type: ascii(bytes, offset + 4, offset + 8),
  };
}

function isoChildBoxes(bytes, start, end) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    const box = readIsoBox(bytes, offset, end, true);
    if (!box || box.truncated) return null;
    boxes.push(box);
    offset = box.end;
  }
  return offset === end ? boxes : null;
}

function isoChild(boxes, type) {
  return boxes?.find((box) => box.type === type) ?? null;
}

function hasIsoVideoTrack(bytes, moov) {
  const moovChildren = isoChildBoxes(bytes, moov.payloadStart, moov.end);
  for (const trak of moovChildren?.filter((box) => box.type === "trak") ?? []) {
    const trakChildren = isoChildBoxes(bytes, trak.payloadStart, trak.end);
    const mdia = isoChild(trakChildren, "mdia");
    if (!mdia) continue;
    const mdiaChildren = isoChildBoxes(bytes, mdia.payloadStart, mdia.end);
    const handler = isoChild(mdiaChildren, "hdlr");
    const minf = isoChild(mdiaChildren, "minf");
    if (
      !handler ||
      handler.end - handler.payloadStart < 12 ||
      ascii(bytes, handler.payloadStart + 8, handler.payloadStart + 12) !==
        "vide" ||
      !minf
    ) {
      continue;
    }
    const minfChildren = isoChildBoxes(bytes, minf.payloadStart, minf.end);
    const stbl = isoChild(minfChildren, "stbl");
    if (!stbl) continue;
    const stblChildren = isoChildBoxes(bytes, stbl.payloadStart, stbl.end);
    const stsd = isoChild(stblChildren, "stsd");
    if (!stsd || stsd.end - stsd.payloadStart < 16) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entryCount = view.getUint32(stsd.payloadStart + 4);
    const entrySize = view.getUint32(stsd.payloadStart + 8);
    if (
      entryCount === 0 ||
      entrySize < 86 ||
      stsd.payloadStart + 8 + entrySize > stsd.end
    ) {
      continue;
    }
    const codec = ascii(bytes, stsd.payloadStart + 12, stsd.payloadStart + 16);
    const samplePayloadStart = stsd.payloadStart + 16;
    const width = view.getUint16(samplePayloadStart + 24);
    const height = view.getUint16(samplePayloadStart + 26);
    if (
      new Set(["av01", "avc1", "hev1", "hvc1", "vp09"]).has(codec) &&
      usefulImageDimensions(width, height)
    ) {
      return true;
    }
  }
  return false;
}

function isoBmffVideoMetadata(bytes, complete) {
  const first = readIsoBox(bytes, 0, bytes.length, complete);
  if (
    first?.type !== "ftyp" ||
    first.truncated ||
    first.end - first.payloadStart < 8 ||
    (first.end - first.payloadStart) % 4 !== 0
  ) {
    return null;
  }
  const brands = [ascii(bytes, first.payloadStart, first.payloadStart + 4)];
  for (
    let offset = first.payloadStart + 8;
    offset + 4 <= first.end;
    offset += 4
  ) {
    brands.push(ascii(bytes, offset, offset + 4));
  }
  if (!brands.some((brand) => ISO_BMFF_VIDEO_BRANDS.has(brand))) return null;
  let offset = first.end;
  let moov = null;
  let hasMediaPayload = false;
  while (offset + 8 <= bytes.length) {
    const box = readIsoBox(bytes, offset, bytes.length, complete);
    if (!box) return null;
    if (box.type === "moov") {
      if (box.truncated) return null;
      moov = box;
    }
    if (box.type === "mdat") {
      const declaredPayload = box.end - box.payloadStart;
      const availablePayload = box.availableEnd - box.payloadStart;
      hasMediaPayload ||= declaredPayload >= 1024 && availablePayload >= 1024;
    }
    if (box.truncated) {
      if (box.type !== "mdat") return null;
      break;
    }
    offset = box.end;
  }
  if (complete && offset !== bytes.length) return null;
  return moov && hasMediaPayload && hasIsoVideoTrack(bytes, moov)
    ? { kind: "video" }
    : null;
}

function readEbmlVint(bytes, offset) {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  const unknown =
    (first & (mask - 1)) === mask - 1 &&
    bytes.subarray(offset + 1, offset + length).every((byte) => byte === 0xff);
  if (unknown) return { length, unknown: true, value: 0 };
  let value = first & (mask - 1);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index];
  }
  if (!Number.isSafeInteger(value)) return null;
  return { length, unknown: false, value };
}

function readEbmlId(bytes, offset) {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 4 || offset + length > bytes.length) return null;
  return {
    id: Array.from(bytes.subarray(offset, offset + length), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    length,
  };
}

function readEbmlElement(bytes, offset, limit) {
  const identifier = readEbmlId(bytes, offset);
  if (!identifier) return null;
  const size = readEbmlVint(bytes, offset + identifier.length);
  if (!size) return null;
  const payloadStart = offset + identifier.length + size.length;
  const end = size.unknown ? limit : payloadStart + size.value;
  if (!Number.isSafeInteger(end)) return null;
  return {
    availableEnd: Math.min(end, limit),
    end,
    id: identifier.id,
    payloadStart,
    truncated: !size.unknown && end > limit,
  };
}

function ebmlChildren(bytes, start, end) {
  const elements = [];
  let offset = start;
  while (offset < end) {
    const element = readEbmlElement(bytes, offset, end);
    if (!element || element.payloadStart > end) return null;
    elements.push(element);
    if (element.truncated || element.end <= offset) break;
    offset = element.end;
  }
  return elements;
}

function ebmlUnsigned(bytes, element) {
  if (!element) return null;
  const length = element.availableEnd - element.payloadStart;
  if (length < 1 || length > 6 || element.truncated) return null;
  let value = 0;
  for (let offset = element.payloadStart; offset < element.end; offset += 1) {
    value = value * 256 + bytes[offset];
  }
  return value;
}

function webmTrackDimensions(bytes, tracks) {
  const trackEntries =
    ebmlChildren(bytes, tracks.payloadStart, tracks.end)?.filter(
      (element) => element.id === "ae" && !element.truncated,
    ) ?? [];
  for (const track of trackEntries) {
    const children = ebmlChildren(bytes, track.payloadStart, track.end);
    const type = children?.find((element) => element.id === "83");
    const video = children?.find((element) => element.id === "e0");
    if (ebmlUnsigned(bytes, type) !== 1 || !video || video.truncated) continue;
    const videoChildren = ebmlChildren(bytes, video.payloadStart, video.end);
    const width = ebmlUnsigned(
      bytes,
      videoChildren?.find((element) => element.id === "b0"),
    );
    const height = ebmlUnsigned(
      bytes,
      videoChildren?.find((element) => element.id === "ba"),
    );
    if (usefulImageDimensions(width, height)) return { height, width };
  }
  return null;
}

function webmClusterHasPayload(bytes, cluster) {
  const children = ebmlChildren(
    bytes,
    cluster.payloadStart,
    cluster.availableEnd,
  );
  for (const child of children ?? []) {
    if (
      child.id === "a3" &&
      child.availableEnd - child.payloadStart >= 256 &&
      readEbmlVint(bytes, child.payloadStart)
    ) {
      return true;
    }
    if (child.id === "a0") {
      const block = ebmlChildren(
        bytes,
        child.payloadStart,
        child.availableEnd,
      )?.find((element) => element.id === "a1");
      if (block && block.availableEnd - block.payloadStart >= 256) return true;
    }
  }
  return false;
}

function webmMetadata(bytes) {
  const header = readEbmlElement(bytes, 0, bytes.length);
  if (header?.id !== "1a45dfa3" || header.truncated) return null;
  const headerChildren = ebmlChildren(bytes, header.payloadStart, header.end);
  const docType = headerChildren?.find((element) => element.id === "4282");
  if (
    !docType ||
    docType.truncated ||
    ascii(bytes, docType.payloadStart, docType.end) !== "webm"
  ) {
    return null;
  }
  const segment = readEbmlElement(bytes, header.end, bytes.length);
  if (segment?.id !== "18538067") return null;
  const children = ebmlChildren(
    bytes,
    segment.payloadStart,
    segment.availableEnd,
  );
  const tracks = children?.find(
    (element) => element.id === "1654ae6b" && !element.truncated,
  );
  const cluster = children?.find((element) => element.id === "1f43b675");
  if (!tracks || !cluster || !webmClusterHasPayload(bytes, cluster))
    return null;
  const dimensions = webmTrackDimensions(bytes, tracks);
  return dimensions ? { ...dimensions, kind: "video" } : null;
}

function mediaMetadataFromBytes(bytes, complete) {
  return (
    pngMetadata(bytes, complete) ??
    jpegMetadata(bytes, complete) ??
    gifMetadata(bytes, complete) ??
    webpMetadata(bytes, complete) ??
    webmMetadata(bytes) ??
    isoBmffVideoMetadata(bytes, complete)
  );
}

function meaningfulJson(value) {
  if (Array.isArray(value)) return value.length > 0;
  return (
    value !== null && typeof value === "object" && Object.keys(value).length > 0
  );
}

function parseJsonLines(text, complete) {
  const lines = text
    .split(/\r?\n/)
    .slice(0, complete ? undefined : -1)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  try {
    const records = lines.map((line) => JSON.parse(line));
    return records.every(meaningfulJson) ? records : null;
  } catch {
    // error-policy:J3 uploaded JSONL is untrusted input; malformed records are
    // an explicit invalid-artifact result at the verification boundary.
    return null;
  }
}

function validateDocument(bytes, complete, artifact, contentType) {
  if (!complete) {
    return `document exceeds the ${DOCUMENT_READ_LIMIT_BYTES}-byte verification limit`;
  }
  if (bytes.length < 64)
    return "document is too small to be substantive evidence";

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "")
      .trim();
  } catch {
    // error-policy:J3 evidence bytes are untrusted input; invalid UTF-8 is an
    // explicit invalid document rather than fabricated readable content.
    return "document is not valid UTF-8 text";
  }
  if (text.length < 64 || NON_REAL_DOCUMENT_RE.test(text)) {
    return "document is too small or identifies itself as non-real evidence";
  }
  const semanticTokens = text.match(/[a-z0-9][a-z0-9._:/-]*/gi) ?? [];
  const uniqueTokens = new Set(
    semanticTokens.map((token) => token.toLowerCase()),
  );
  if (semanticTokens.join("").length < 40 || uniqueTokens.size < 3) {
    return "document is structurally trivial and lacks substantive records";
  }

  const extension = artifact.extension;
  let parsedJson = null;
  let parsedJsonLines = null;
  const jsonContentType =
    contentType === "application/json" || contentType.endsWith("+json");
  const jsonLinesContentType =
    contentType === "application/jsonl" ||
    contentType === "application/x-ndjson";
  if (extension === ".json" || jsonContentType) {
    try {
      parsedJson = JSON.parse(text);
    } catch {
      // error-policy:J3 uploaded JSON is untrusted input; malformed JSON is an
      // explicit invalid-artifact verdict.
      return "JSON evidence is malformed";
    }
    if (!meaningfulJson(parsedJson)) return "JSON evidence has no records";
  }
  if (extension === ".jsonl" || jsonLinesContentType) {
    parsedJsonLines = parseJsonLines(text, complete);
    if (!parsedJsonLines) return "JSONL evidence has no valid complete records";
  }
  if (parsedJson === null && parsedJsonLines === null && /^[{[]/.test(text)) {
    try {
      const sniffedJson = JSON.parse(text);
      if (meaningfulJson(sniffedJson)) parsedJson = sniffedJson;
    } catch {
      parsedJsonLines = parseJsonLines(text, complete);
    }
  }
  if (artifact.id === "backend-logs" || artifact.id === "frontend-logs") {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const structuredRecords =
      (Array.isArray(parsedJson) && parsedJson.length >= 2) ||
      (parsedJson &&
        !Array.isArray(parsedJson) &&
        Object.keys(parsedJson).length >= 2) ||
      (parsedJsonLines?.length ?? 0) >= 2;
    const structuredLogText = JSON.stringify(parsedJson ?? parsedJsonLines);
    if (
      (!structuredRecords ||
        !/\b(?:entries|events|level|logs?|method|requests?|responses?|status|timestamp|url)\b/i.test(
          structuredLogText,
        )) &&
      (lines.length < 3 ||
        !/(?:^\$\s+\S+|^\((?:pass|fail)\)|\bTest Files\b|\bTests\s+\d+\s+(?:passed|failed)\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\b(?:INFO|WARN|ERROR|DEBUG|TRACE)\b|HTTP\/[12](?:\.\d)?\s+\d{3}|\bstatus(?:Code)?["'=:\s]+\d{3}\b)/im.test(
          text,
        ))
    ) {
      return "log evidence needs at least three recognizable log lines or structured records";
    }
  }

  if (artifact.id === "llm-trajectory") {
    const trajectory = parsedJson ?? parsedJsonLines;
    if (
      trajectory === null ||
      JSON.stringify(trajectory).length < 120 ||
      !hasTrajectorySemantics(trajectory)
    ) {
      return "trajectory evidence lacks substantive model/input/output records";
    }
  }
  return null;
}

function isHtmlResponse(contentType, bytes) {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    return true;
  }
  const prefix = TEXT_DECODER.decode(bytes.subarray(0, 512))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return (
    prefix.startsWith("<!doctype html") ||
    prefix.startsWith("<html") ||
    prefix.startsWith("<head")
  );
}

function withAbort(promise, signal) {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readResponsePrefix(response, signal, readLimit) {
  if (!response.body) {
    return {
      bytes: new Uint8Array(),
      complete: true,
      lengthError: null,
      totalBytes: 0,
    };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let complete = false;
  try {
    while (length < readLimit) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      if (!value || value.length === 0) continue;
      const remaining = readLimit - length;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      length += chunk.length;
    }
  } finally {
    if (!complete) {
      // Promise.race installs rejection handling on cancellation without
      // letting a hostile response stream extend the request deadline.
      await Promise.race([reader.cancel(), Promise.resolve()]);
    }
  }

  const prefix = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.length;
  }
  const parseByteCount = (value) => {
    if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value.trim())) {
      return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const rawContentLength = response.headers.get("content-length");
  const contentLength = parseByteCount(rawContentLength);
  if (rawContentLength !== null && contentLength === null) {
    return {
      bytes: prefix,
      complete: false,
      lengthError: "Content-Length is not a valid non-negative byte count",
      totalBytes: null,
    };
  }

  const rawContentRange = response.headers.get("content-range");
  let range = null;
  if (rawContentRange !== null) {
    const match = rawContentRange
      .trim()
      .match(/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/i);
    if (match) {
      const [start, end, total] = match.slice(1).map(Number);
      if (
        [start, end, total].every(Number.isSafeInteger) &&
        start === 0 &&
        end >= start &&
        total > end
      ) {
        range = { end, start, total };
      }
    }
    if (!range) {
      return {
        bytes: prefix,
        complete: false,
        lengthError: "Content-Range is malformed or does not begin at byte 0",
        totalBytes: null,
      };
    }
  }
  if (response.status === 206 && !range) {
    return {
      bytes: prefix,
      complete: false,
      lengthError: "HTTP 206 response omitted a valid Content-Range header",
      totalBytes: null,
    };
  }

  const expectedResponseBytes = range
    ? range.end - range.start + 1
    : contentLength;
  if (
    expectedResponseBytes !== null &&
    ((complete && expectedResponseBytes !== prefix.length) ||
      expectedResponseBytes < prefix.length)
  ) {
    return {
      bytes: prefix,
      complete: false,
      lengthError: "declared response length does not match the received bytes",
      totalBytes: range?.total ?? contentLength,
    };
  }

  const totalBytes = range?.total ?? contentLength;
  const artifactComplete = range
    ? range.end + 1 === range.total
    : complete || (contentLength !== null && contentLength === prefix.length);
  return {
    bytes: prefix,
    complete: artifactComplete,
    lengthError: null,
    totalBytes,
  };
}

function trustedDownloadUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    // error-policy:J3 redirect locations are untrusted transport input.
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !TRUSTED_ARTIFACT_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return null;
  }
  return url;
}

async function fetchArtifactResponse(
  artifact,
  fetchImpl,
  token,
  controller,
  readLimit,
) {
  let currentUrl = trustedDownloadUrl(artifact.url);
  if (!currentUrl) {
    return {
      failure: {
        status: "artifact-untrusted-redirect",
        detail: "initial artifact host is not trusted",
      },
    };
  }

  for (let redirects = 0; redirects <= MAX_ARTIFACT_REDIRECTS; redirects += 1) {
    const headers = new Headers({
      Accept: "*/*",
      Range: `bytes=0-${readLimit - 1}`,
    });
    // GitHub bearer credentials are scoped to github.com. Signed CDN URLs need
    // no credential and must never receive the token after a redirect.
    if (token && currentUrl.hostname.toLowerCase() === "github.com") {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const response = await withAbort(
      fetchImpl(currentUrl.href, {
        headers,
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      }),
      controller.signal,
    );
    const responseUrl = response.url
      ? trustedDownloadUrl(response.url)
      : currentUrl;
    if (!responseUrl) {
      return {
        failure: {
          status: "artifact-untrusted-redirect",
          detail: "response resolved to an untrusted host",
        },
      };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          failure: {
            status: "artifact-redirect-error",
            detail: `HTTP ${response.status} omitted the Location header`,
          },
        };
      }
      const nextUrl = trustedDownloadUrl(new URL(location, currentUrl).href);
      if (!nextUrl) {
        return {
          failure: {
            status: "artifact-untrusted-redirect",
            detail: "redirect target is not an approved GitHub artifact host",
          },
        };
      }
      if (redirects === MAX_ARTIFACT_REDIRECTS) {
        return {
          failure: {
            status: "artifact-redirect-error",
            detail: `redirect limit of ${MAX_ARTIFACT_REDIRECTS} exceeded`,
          },
        };
      }
      currentUrl = nextUrl;
      continue;
    }
    return { response };
  }
  throw new Error("unreachable artifact redirect state");
}

async function verifyArtifact(
  artifact,
  fetchImpl,
  token,
  timeoutMs,
  contentDigestLimitBytes,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const readLimit =
    contentDigestLimitBytes ??
    (artifact.expectedKind === "document"
      ? DOCUMENT_READ_LIMIT_BYTES
      : ARTIFACT_READ_LIMIT_BYTES);

  try {
    const fetched = await fetchArtifactResponse(
      artifact,
      fetchImpl,
      token,
      controller,
      readLimit,
    );
    if (fetched.failure) return fetched.failure;
    const { response } = fetched;
    if (!response.ok) {
      return {
        status: "artifact-http-error",
        detail: `HTTP ${response.status}`,
      };
    }

    const { bytes, complete, lengthError, totalBytes } =
      await readResponsePrefix(response, controller.signal, readLimit);
    if (lengthError) {
      return { status: "artifact-invalid", detail: lengthError };
    }
    if (bytes.length === 0) {
      return {
        status: "artifact-empty",
        detail: "response body is empty",
      };
    }
    if (contentDigestLimitBytes !== null && !complete) {
      return {
        status: "artifact-invalid",
        detail: `artifact exceeds the ${contentDigestLimitBytes}-byte content verification limit`,
      };
    }

    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (isHtmlResponse(contentType, bytes)) {
      return {
        status: "artifact-html",
        detail: "response is HTML, not an uploaded artifact",
      };
    }

    const mediaMetadata = mediaMetadataFromBytes(bytes, complete);
    const actualKind = mediaMetadata?.kind ?? null;
    const requiresRecognizedMedia =
      artifact.expectedKind === "image" || artifact.expectedKind === "video";
    if (
      artifact.expectedKind &&
      ((requiresRecognizedMedia && actualKind !== artifact.expectedKind) ||
        (actualKind && artifact.expectedKind !== actualKind))
    ) {
      return {
        status: "artifact-kind-mismatch",
        detail: `expected ${artifact.expectedKind}, received ${actualKind ?? "unrecognized bytes"}`,
      };
    }
    if (
      (contentType.startsWith("image/") || contentType.startsWith("video/")) &&
      !actualKind
    ) {
      return {
        status: "artifact-kind-mismatch",
        detail: "media response is truncated or structurally invalid",
      };
    }
    const effectiveSize = totalBytes ?? (complete ? bytes.length : null);
    if (
      actualKind === "image" &&
      effectiveSize !== null &&
      effectiveSize < MIN_IMAGE_BYTES
    ) {
      return {
        status: "artifact-invalid",
        detail: `image evidence is smaller than ${MIN_IMAGE_BYTES} bytes`,
      };
    }
    if (
      actualKind === "video" &&
      effectiveSize !== null &&
      effectiveSize < MIN_VIDEO_BYTES
    ) {
      return {
        status: "artifact-invalid",
        detail: `video evidence is smaller than ${MIN_VIDEO_BYTES} bytes`,
      };
    }
    if (
      artifact.expectedKind === "document" ||
      (!actualKind && artifact.expectedKind === null)
    ) {
      const invalidDocument = validateDocument(
        bytes,
        complete,
        artifact,
        contentType,
      );
      if (invalidDocument) {
        return { status: "artifact-invalid", detail: invalidDocument };
      }
    }
    if (
      !artifact.expectedKind &&
      !actualKind &&
      UNRELIABLE_CONTENT_TYPES.has(contentType)
    ) {
      const distinctBytes = new Set(bytes).size;
      if (bytes.length < 64 || distinctBytes < 4) {
        return {
          status: "artifact-invalid",
          detail: "opaque artifact is too small or structurally trivial",
        };
      }
    }
    return {
      status: "ok",
      contentSha256: complete
        ? createHash("sha256").update(bytes).digest("hex")
        : null,
    };
  } catch (error) {
    // error-policy:J1 the CLI boundary translates transport failures into a
    // row-level verification failure instead of accepting unreachable proof.
    const timedOut = controller.signal.aborted;
    return {
      status: timedOut ? "artifact-timeout" : "artifact-fetch-error",
      detail: timedOut
        ? `request exceeded ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "artifact request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Resolves every trusted artifact referenced by an evidence row. Fetch is
 * injected for deterministic tests; the CLI uses the runtime implementation.
 */
export async function verifyReferencedArtifacts(
  body,
  requiredRows = REQUIRED_EVIDENCE_ROWS,
  options = {},
) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError(
      "Artifact verification requires a fetch implementation",
    );
  }
  const concurrency = Math.max(
    1,
    Math.min(
      16,
      Math.trunc(options.concurrency ?? DEFAULT_ARTIFACT_CONCURRENCY),
    ),
  );
  const timeoutMs = Math.max(
    1,
    Math.min(
      60_000,
      Math.trunc(options.timeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS),
    ),
  );
  const contentDigestLimitBytes =
    options.contentDigestLimitBytes === undefined
      ? null
      : Math.max(
          ARTIFACT_READ_LIMIT_BYTES,
          Math.min(
            MAX_CONTENT_DIGEST_BYTES,
            Math.trunc(options.contentDigestLimitBytes),
          ),
        );
  // This standalone script runs outside Turbo task caching; credentials affect
  // transport access, never the deterministic evidence verdict.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: optional standalone CLI credential
  const githubToken = process.env.GITHUB_TOKEN;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: optional standalone CLI credential
  const ghToken = process.env.GH_TOKEN;
  const token = options.token ?? githubToken ?? ghToken ?? "";
  const allowedArtifactKinds = options.allowedArtifactKinds
    ? new Set(options.allowedArtifactKinds)
    : null;
  const rows = extractEvidenceRows(String(body ?? ""));
  const references = [];
  const uniqueArtifacts = new Map();
  const limitFindings = [];

  for (const { id, label } of requiredRows) {
    const rowText = rows.get(id);
    if (rowText === undefined) continue;
    const rowArtifacts = trustedArtifacts(rowText).filter(
      (artifact) =>
        allowedArtifactKinds === null ||
        allowedArtifactKinds.has(artifact.kind),
    );
    if (rowArtifacts.length > MAX_ARTIFACTS_PER_ROW) {
      limitFindings.push({
        id,
        label,
        url: "(artifact count)",
        status: "artifact-limit-exceeded",
        detail: `row references ${rowArtifacts.length} artifacts; maximum is ${MAX_ARTIFACTS_PER_ROW}`,
      });
    }
    for (const artifact of rowArtifacts) {
      const reference = {
        ...artifact,
        expectedKind: expectedArtifactKind(id, artifact, rowText),
        id,
        label,
      };
      references.push(reference);
      if (!uniqueArtifacts.has(artifact.identity)) {
        uniqueArtifacts.set(artifact.identity, reference);
      }
    }
  }

  const referencesByIdentity = new Map();
  for (const reference of references) {
    const uses = referencesByIdentity.get(reference.identity) ?? [];
    uses.push(reference);
    referencesByIdentity.set(reference.identity, uses);
  }
  for (const uses of referencesByIdentity.values()) {
    const rowIds = new Set(uses.map(({ id }) => id));
    if (rowIds.size < 2) continue;
    const kinds = new Set(
      uses.map(({ expectedKind }) => expectedKind ?? "unspecified"),
    );
    for (const use of uses) {
      limitFindings.push({
        id: use.id,
        label: use.label,
        url: use.url,
        status: "artifact-conflict",
        detail: `artifact is reused by ${[...rowIds].join(", ")} with expected kinds ${[...kinds].join(", ")}`,
      });
    }
  }

  const artifacts = [...uniqueArtifacts.values()];
  if (artifacts.length > MAX_ARTIFACTS_TOTAL) {
    const firstReference = references[0];
    limitFindings.push({
      id: firstReference?.id ?? requiredRows[0]?.id ?? "evidence",
      label:
        firstReference?.label ??
        requiredRows[0]?.label ??
        "Referenced evidence artifacts",
      url: "(artifact count)",
      status: "artifact-limit-exceeded",
      detail: `PR references ${artifacts.length} unique artifacts; maximum is ${MAX_ARTIFACTS_TOTAL}`,
    });
  }
  if (limitFindings.length > 0) {
    return {
      ok: false,
      findings: limitFindings,
    };
  }
  const results = await mapWithConcurrency(artifacts, concurrency, (artifact) =>
    verifyArtifact(
      artifact,
      fetchImpl,
      token,
      timeoutMs,
      contentDigestLimitBytes,
    ),
  );
  const resultsByIdentity = new Map(
    artifacts.map((artifact, index) => [artifact.identity, results[index]]),
  );
  const findings = references.map(({ id, identity, kind, label, url }) => {
    const result = resultsByIdentity.get(identity);
    return {
      id,
      label,
      url,
      artifactKind: kind,
      ...result,
    };
  });
  return {
    ok: findings.every((finding) => finding.status === "ok"),
    findings,
  };
}

export function artifactVerificationRows(
  body,
  requiredRows = REQUIRED_EVIDENCE_ROWS,
) {
  const rows = extractEvidenceRows(String(body ?? ""));
  if (
    !rows.has(SURFACE_OCR_EVIDENCE_ROW.id) ||
    requiredRows.some((row) => row.id === SURFACE_OCR_EVIDENCE_ROW.id)
  ) {
    return requiredRows;
  }
  return [...requiredRows, SURFACE_OCR_EVIDENCE_ROW];
}

/** Counts only artifact references accepted by this verifier's trust policy. */
export function planReferencedArtifacts(
  body,
  requiredRows = REQUIRED_EVIDENCE_ROWS,
  options = {},
) {
  const rows = extractEvidenceRows(String(body ?? ""));
  const allowedArtifactKinds = options.allowedArtifactKinds
    ? new Set(options.allowedArtifactKinds)
    : null;
  const identities = new Set();
  let referenceCount = 0;
  for (const { id } of requiredRows) {
    const rowText = rows.get(id);
    if (rowText === undefined) continue;
    const artifacts = trustedArtifacts(rowText).filter(
      (artifact) =>
        allowedArtifactKinds === null ||
        allowedArtifactKinds.has(artifact.kind),
    );
    referenceCount += artifacts.length;
    for (const artifact of artifacts) identities.add(artifact.identity);
  }
  return {
    referenceCount,
    uniqueArtifactCount: identities.size,
  };
}

function combineVerificationFindings(evaluationFindings, remoteFindings) {
  const failuresByRow = new Map();
  for (const finding of remoteFindings) {
    if (finding.status === "ok") continue;
    const failures = failuresByRow.get(finding.id) ?? [];
    failures.push(finding);
    failuresByRow.set(finding.id, failures);
  }

  return evaluationFindings.map((finding) => {
    const failures = failuresByRow.get(finding.id);
    if (!failures) return finding;
    const verificationDetail = failures
      .map(({ detail, status, url }) => `${status}: ${url} (${detail})`)
      .join("; ");
    if (finding.status !== "ok") {
      return {
        ...finding,
        detail: [finding.detail, verificationDetail].filter(Boolean).join("; "),
        verificationFailures: failures,
      };
    }
    const statuses = new Set(failures.map(({ status }) => status));
    return {
      ...finding,
      status:
        statuses.size === 1
          ? failures[0].status
          : "artifact-verification-failed",
      detail: verificationDetail,
      verificationFailures: failures,
    };
  });
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

function readFileListArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return [];

  const file = args[idx + 1];
  if (!file) {
    console.error(`${flag} requires a path argument`);
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
  --added-files-file <path>
                      Newline list of ADDED files (git diff --diff-filter=A).
                      When every rendered-UI file in the diff is newly added,
                      the before-screenshots row may be 'N/A - <reason>' (a
                      brand-new surface has no before state).
  --json              Print machine-readable findings JSON.
  --head-sha <sha>    Require the evidence-head marker to match this PR head.
  --self-test         Run the planted-fixture self-check.
  --help, -h          Show this help.

Environment:
  GITHUB_TOKEN or GH_TOKEN
                      Optional token sent while resolving trusted artifacts.
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
      "- [ ] Backend logs: [backend.txt](https://github.com/user-attachments/files/10000001/backend.txt)",
    "frontend-logs": "- [ ] Frontend logs `N/A - no frontend change`.",
    "llm-trajectory":
      "- [ ] Real-LLM trajectory: [report](https://github.com/elizaOS/eliza/releases/download/pr-evidence/fixture-trajectory.json)",
    "domain-artifacts":
      "- [ ] Domain artifacts: [export](https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000007)",
    "ocr-review":
      "- [ ] OCR review `N/A - backend-only change has no rendered visual surface`.",
  };
  const merged = { ...defaults, ...overrides };
  return [...REQUIRED_EVIDENCE_ROWS, SURFACE_OCR_EVIDENCE_ROW]
    .map(({ id }) => `<!-- evidence-row:${id} -->\n${merged[id] ?? ""}`)
    .join("\n\n");
}

export function runSelfTest() {
  const failures = [];

  {
    const { ok } = evaluatePrEvidence(buildFixtureBody());
    if (!ok) failures.push("all-filled fixture should pass");
  }

  {
    // Both directions of the fabrication-marker rule. A marker inside an
    // identifier is not a fabrication claim; a bare one still is. Without the
    // second half, tightening the boundaries could quietly disarm the check.
    const naming = [
      "- [x] Backend logs:",
      "```",
      "$ bun run audit:test-integrity:no-vi-mocks",
      "packages/scripts/lint-no-vi-mocks.mjs:12: const json = vi.fn();",
      "running fixtures/setup.ts against the real adapter",
      "loaded fixture.json through object.mock and test:mocks",
      String.raw`opened C:\fixtures\setup.ts and todo.md`,
      "exit 0 after 41s",
      "```",
    ].join("\n");
    const named = evaluatePrEvidence(
      buildFixtureBody({ "backend-logs": naming }),
    );
    const namedRow = named.findings.find((f) => f.id === "backend-logs");
    if (namedRow?.status !== "ok") {
      failures.push(
        "a transcript naming a marker-bearing command or path should satisfy the gate",
      );
    }

    const disclosed = [
      "- [x] Backend logs:",
      "```",
      "this run uses mocks instead of the real service",
      "TODO: logs here",
      "the remaining output is a placeholder pending a real capture run",
      "the artifact is fake.",
      "```",
    ].join("\n");
    const fabricated = evaluatePrEvidence(
      buildFixtureBody({ "backend-logs": disclosed }),
    );
    const fabricatedRow = fabricated.findings.find(
      (f) => f.id === "backend-logs",
    );
    if (fabricatedRow?.status === "ok") {
      failures.push(
        "a disclosed placeholder/mocked run must still be rejected",
      );
    }
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
    if (blank?.detail) {
      failures.push("an empty row must not claim a transcript shortfall");
    }
  }

  {
    // Pins the documented forms to the implemented ones: the failure help
    // advertises a pasted transcript, so a compliant one must satisfy the gate.
    // Without this, the help and `hasInlineTranscriptEvidence` can drift apart
    // and outside contributors — who cannot upload release assets — are told
    // their only options are a link or `N/A`.
    const transcript = [
      "- [x] Backend logs:",
      "```",
      "[develop-pr-gate] poll 1: passed=0 waiting=3 failed=0",
      "[develop-pr-gate] poll 2: passed=2 waiting=1 failed=0",
      "[develop-pr-gate] poll 3: passed=3 waiting=0 failed=0",
      "[develop-pr-gate] all required checks green after 92s",
      "```",
    ].join("\n");
    const { ok, findings } = evaluatePrEvidence(
      buildFixtureBody({ "backend-logs": transcript }),
    );
    const row = findings.find((finding) => finding.id === "backend-logs");
    if (!ok || row?.status !== "ok") {
      failures.push(
        "a pasted transcript meeting the documented floor should satisfy the gate",
      );
    }
  }

  {
    // The help tells authors to prefer <details> because it is the only form
    // that survives a blank line. Pin that promise.
    const withBlankLines = [
      "- [x] Backend logs:",
      "",
      "<details><summary>gate output</summary>",
      "",
      "```",
      "[develop-pr-gate] poll 1: passed=0 waiting=3 failed=0",
      "",
      "[develop-pr-gate] poll 2: passed=2 waiting=1 failed=0",
      "[develop-pr-gate] all required checks green after 92s",
      "```",
      "",
      "</details>",
    ].join("\n");
    const { findings } = evaluatePrEvidence(
      buildFixtureBody({ "backend-logs": withBlankLines }),
    );
    const row = findings.find((finding) => finding.id === "backend-logs");
    if (row?.status !== "ok") {
      failures.push(
        "a <details> transcript containing blank lines should satisfy the gate",
      );
    }
  }

  {
    // A transcript that just misses the floor is a different mistake from an
    // empty row, and must say which threshold it missed.
    const short = ["- [x] Backend logs:", "```", "poll 1: ok", "```"].join(
      "\n",
    );
    const { findings } = evaluatePrEvidence(
      buildFixtureBody({ "backend-logs": short }),
    );
    const row = findings.find((finding) => finding.id === "backend-logs");
    if (row?.status !== "blank") {
      failures.push("an under-floor transcript should still fail");
    }
    if (!row?.detail?.includes("under the floor")) {
      failures.push(
        "an under-floor transcript should report which threshold it missed",
      );
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

  // A pasted transcript is the format CONTRIBUTING.md § Evidence prescribes for
  // logs, so it must satisfy a non-visual row on its own.
  {
    const { ok, findings } = evaluatePrEvidence(
      buildFixtureBody({
        "backend-logs": [
          "- [x] Boot-path run over the real vault backend.",
          "  <details><summary>connector-vault-refs</summary><pre>",
          "  $ vitest run packages/agent/src/runtime/connector-vault-refs.test.ts",
          "  Test Files  1 passed (1)",
          "       Tests  13 passed (13)",
          "    - ref resolves -> settings carry plaintext; process.env asserted clean",
          "  </pre></details>",
        ].join("\n"),
      }),
    );
    const row = findings.find((finding) => finding.id === "backend-logs");
    if (!ok) failures.push("inline transcript fixture should pass");
    if (row?.status !== "ok") {
      failures.push("inline transcript row should be reported ok");
    }
  }

  // The floor is what keeps the allowance from becoming a rubber stamp: an
  // empty container and a one-line "see attached" must both still fail.
  for (const [name, rowText] of [
    ["empty details block", "- [x] Backend logs.\n  <details></details>"],
    [
      "summary-only details block",
      "- [x] Backend logs.\n  <details><summary>backend logs for the whole run</summary></details>",
    ],
    ["one-line code fence", "- [x] Backend logs.\n  ```\n  ok\n  ```"],
  ]) {
    const { ok, findings } = evaluatePrEvidence(
      buildFixtureBody({ "backend-logs": rowText }),
    );
    const row = findings.find((finding) => finding.id === "backend-logs");
    if (ok) failures.push(`${name} fixture should fail`);
    if (row?.status !== "blank") {
      failures.push(`${name} row should be reported blank`);
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
    const { ok } = evaluatePrEvidence(
      buildFixtureBody(),
      REQUIRED_EVIDENCE_ROWS,
      {
        changedFiles: [
          "packages/ui/src/components/Foo.test.tsx",
          "packages/app-core/src/services/thing.ts",
          "packages/ui/src/components/Foo.stories.tsx",
        ],
      },
    );
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

  {
    // A body written without ANY template markers (prose-only evidence notes,
    // the #16925/#16913 failure shape) reports every required row missing —
    // the CLI layer keys its "template was removed" hint off this shape.
    const { ok, findings } = evaluatePrEvidence(
      "Evidence rows: UI/video/frontend N/A - cloud backend latency.",
    );
    if (ok) failures.push("marker-free body should fail");
    if (!findings.every((finding) => finding.status === "missing")) {
      failures.push("marker-free body should report every row missing");
    }
  }

  {
    // An overflow-release (pr-evidence-N) screenshot satisfies a UI-file surface
    // PR identically to a primary-release one — the storage location moved, the
    // gate did not.
    const dl = (tag, name) =>
      `https://github.com/elizaOS/eliza/releases/download/${tag}/${name}`;
    const { ok } = evaluatePrEvidence(
      buildFixtureBody({
        "before-screenshots": `- [x] ![before](${dl("pr-evidence-2", "16367-before.jpg")})`,
        "after-screenshots": `- [x] ![after](${dl("pr-evidence-2", "16367-after.jpg")})`,
        "walkthrough-video": `- [x] ${dl("pr-evidence-2", "16367-walk.mp4")}`,
        "ocr-review": `- [ ] OCR text readout: ${dl("pr-evidence-3", "16367-ocr.jsonl")}`,
      }),
      REQUIRED_EVIDENCE_ROWS,
      { changedFiles: ["packages/ui/src/components/Foo.tsx"] },
    );
    if (!ok)
      failures.push("overflow-release evidence on a surface PR should pass");
  }

  {
    // A link to the release PAGE (not a /download/ asset) is not a screenshot.
    const { ok } = evaluatePrEvidence(
      buildFixtureBody({
        "before-screenshots":
          "- [ ] Before screenshots: https://github.com/elizaOS/eliza/releases/tag/pr-evidence-2",
      }),
      REQUIRED_EVIDENCE_ROWS,
      { changedFiles: ["packages/ui/src/components/Foo.tsx"] },
    );
    if (ok) failures.push("release-page link must not satisfy a visual row");
  }

  if (failures.length > 0) {
    console.error("check-pr-evidence self-test FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("check-pr-evidence self-test passed (14 cases).");
}

// The diagnostic for a PR body carrying NONE of the template's evidence-row
// markers (the #16925/#16913 failure shape). The --row flags are generated
// from REQUIRED_EVIDENCE_ROWS so the hint can never drift from the rows the
// gate actually enforces.
export function markerFreeBodyHint() {
  const rowFlags = REQUIRED_EVIDENCE_ROWS.map(
    ({ id }) => `    --row ${id}=<file|url|"N/A - <reason>">`,
  ).join(" \\\n");
  return `NO evidence-row markers found in the PR body. The gate locates each row
by its HTML marker (\`<!-- evidence-row:<id> -->\`) from the PR template —
prose like "Evidence rows: N/A - backend only" cannot be matched without them.
This usually means the PR template section was deleted or the body was written
from scratch.

Fix in one command (uploads/patches rows AND re-adds the missing markers; each
row takes a local file, an existing URL, or an "N/A - <reason>" string):
  node scripts/pr-evidence.mjs rows <pr> \\
${rowFlags}
Or copy the \`<!-- evidence-row:* -->\` block from .github/pull_request_template.md
into the PR description and fill each row.`;
}

async function main() {
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
  const changedFiles = readFileListArg(args, "--changed-files-file");
  const addedFiles = readFileListArg(args, "--added-files-file");
  const headIndex = args.indexOf("--head-sha");
  const headSha = headIndex === -1 ? null : (args[headIndex + 1] ?? "");
  const retiredEvidenceFiles = findRetiredRepoEvidenceFiles(changedFiles);
  const evaluation = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
    labels,
    changedFiles,
    addedFiles,
  });
  const verification = await verifyReferencedArtifacts(
    body,
    artifactVerificationRows(body),
  );
  const findings = combineVerificationFindings(
    evaluation.findings,
    verification.findings,
  );
  const headOk = headSha === null || hasMatchingEvidenceHead(body, headSha);
  if (!headOk) {
    findings.push({
      id: "evidence-head",
      label: "Evidence head SHA",
      status: "head-mismatch",
      detail: "evidence-head marker must match the current PR head SHA",
    });
  }
  const allOk =
    evaluation.ok &&
    verification.ok &&
    headOk &&
    retiredEvidenceFiles.length === 0;

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          ok: allOk,
          findings,
          artifactFindings: verification.findings,
          retiredEvidenceFiles,
        },
        null,
        2,
      ),
    );
  } else {
    for (const finding of findings) {
      const symbol = finding.status === "ok" ? "ok  " : "FAIL";
      const detail = finding.detail ? ` — ${finding.detail}` : "";
      console.log(
        `  [${symbol}] ${finding.label} (${finding.id}): ${finding.status}${detail}`,
      );
    }
    if (retiredEvidenceFiles.length > 0) {
      console.log("  [FAIL] Retired repo evidence files:");
      for (const file of retiredEvidenceFiles) console.log(`    - ${file}`);
    }
  }

  if (!allOk) {
    const bad = findings.filter((finding) => finding.status !== "ok");
    const requiredIds = new Set(REQUIRED_EVIDENCE_ROWS.map(({ id }) => id));
    const allRequiredMissing = findings
      .filter((finding) => requiredIds.has(finding.id))
      .every((finding) => finding.status === "missing");
    if (allRequiredMissing) {
      console.error(`\n${markerFreeBodyHint()}`);
    }
    console.error(
      `\nEvidence gate FAILED: ${bad.length} row(s) need attention, ${retiredEvidenceFiles.length} retired repo evidence file(s) changed.

How to fix (fastest path):
  1. bun run evidence:doctor            # install any missing capture tool
  2. capture: bun run --cwd packages/app audit:app  (screenshots + OCR)
     and/or the fixtures under packages/ui/src/components/shell/__e2e__/
  3. attach + patch rows in ONE command:
     node scripts/pr-evidence.mjs rows <pr> \\
       --row after-screenshots=shot.jpg --row walkthrough-video=walk.mp4 \\
       --row ocr-review=ocr.txt --row frontend-logs=e2e.log ...
     (uploads to the pr-evidence release and verifies this gate locally)

Rules: visual rows on UI-touching PRs need REAL media (an uploaded image/video,
not a link to the PR or /checks page); every other row needs an artifact link,
a pasted transcript, or 'N/A - <reason>'. A wholly-new surface may N/A the
before-screenshots row.

Pasted transcripts must be at least ${INLINE_TRANSCRIPT_MIN_LINES} lines and ${INLINE_TRANSCRIPT_MIN_CHARS} characters, and must stay
inside the row block. CONTRIBUTING.md § Evidence prefers a <details> block;
complete backtick or tilde fences are also supported, including a blank line
before the fence and blank lines inside it. Unclosed containers fail closed so
they cannot absorb unrelated prose below the evidence row.
Worked example: https://github.com/elizaOS/eliza/pull/15171
Full standard: CONTRIBUTING.md § Evidence.`,
    );
    process.exit(1);
  }
  console.log("\nEvidence gate passed: all required rows satisfied.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
