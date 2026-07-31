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
  /(^|\/)(packages\/(app|ui|tui|homepage|eliza-computer)|apps\/app|packages\/cloud\/frontend|packages\/os\/landing)\//i;
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

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const EVIDENCE_FILE_EXTENSIONS = new Set([
  ".csv",
  ".html",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".txt",
  ".zip",
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
  if (extension === null) return null;
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

const NON_REAL_EVIDENCE_RE =
  /\b(?:placeholder|example output|logs? here|todo|tbd|fabricated|invented|fake|mocks?|fixtures?|synthetic|dummy)\b/i;

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
  const source = String(text ?? "");
  const blocks = [
    ...source.matchAll(/<details[\s\S]*?<\/details>/gi),
    ...source.matchAll(/<pre[\s\S]*?<\/pre>/gi),
    ...source.matchAll(/```[\s\S]*?```/g),
  ].map((match) => match[0]);
  return blocks.some((block) => {
    const content = block
      // A <summary> is a caption, not evidence — it must not carry the block.
      .replace(/<summary[\s\S]*?<\/summary>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/```/g, " ");
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return (
      lines.length >= INLINE_TRANSCRIPT_MIN_LINES &&
      lines.join("").length >= INLINE_TRANSCRIPT_MIN_CHARS &&
      !NON_REAL_EVIDENCE_RE.test(content)
    );
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
      hasEvidenceFileReference(rowText) || hasInlineTranscriptEvidence(rowText)
    );
  }
  return hasArtifactReference(rowText) || hasInlineTranscriptEvidence(rowText);
}

export function boundRowBlock(block) {
  const lines = block.split(/\r?\n/);
  const out = [];
  let started = false;
  let detailsDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!started) {
      if (line.trim() === "") continue;
      started = true;
      out.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "") {
      if (detailsDepth > 0) {
        out.push(line);
        continue;
      }
      const next = lines.slice(index + 1).find((candidate) => candidate.trim());
      if (next && /^<details\b/i.test(next.trim())) {
        out.push(line);
        continue;
      }
      break;
    }
    if (detailsDepth === 0 && /^#/.test(trimmed)) break;
    if (/<!--\s*evidence-row:/i.test(trimmed)) break;
    if (detailsDepth === 0 && /^[-*]\s/.test(line) && !/^\s/.test(line)) {
      break;
    }
    out.push(line);
    detailsDepth += (line.match(/<details\b/gi) ?? []).length;
    detailsDepth -= (line.match(/<\/details>/gi) ?? []).length;
    detailsDepth = Math.max(0, detailsDepth);
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
  const duplicateArtifacts = duplicateArtifactsByRow(rows, requiredRows);
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
    return {
      id,
      label,
      status:
        artifactRequired || isEvidenceRowSatisfied(id, rowText)
          ? "ok"
          : "blank",
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

const ARTIFACT_READ_LIMIT_BYTES = 16 * 1024;
const DEFAULT_ARTIFACT_CONCURRENCY = 4;
const DEFAULT_ARTIFACT_TIMEOUT_MS = 10_000;
export const MAX_ARTIFACTS_PER_ROW = 8;
export const MAX_ARTIFACTS_TOTAL = 32;
const UNRELIABLE_CONTENT_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);
const ISO_BMFF_IMAGE_BRANDS = new Set([
  "avif",
  "avis",
  "heic",
  "heix",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
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

function expectedArtifactKind(rowId, artifact, rowText) {
  if (rowId === "before-screenshots" || rowId === "after-screenshots") {
    return "image";
  }
  if (rowId === "walkthrough-video") return "video";
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

function mediaKindFromBytes(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image";
  }
  if (
    bytes.length >= 6 &&
    new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/)
  ) {
    return "image";
  }
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video";
  }
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp"
  ) {
    const declaredSize = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint32(0);
    const availableEnd = Math.min(
      bytes.length,
      declaredSize >= 16 ? declaredSize : bytes.length,
    );
    const brands = [];
    for (let offset = 8; offset + 4 <= availableEnd; offset += 4) {
      // Offset 12 is the minor version rather than a compatible brand.
      if (offset !== 12) {
        brands.push(
          new TextDecoder().decode(bytes.subarray(offset, offset + 4)),
        );
      }
    }
    if (brands.some((brand) => ISO_BMFF_IMAGE_BRANDS.has(brand))) {
      return "image";
    }
    if (brands.some((brand) => ISO_BMFF_VIDEO_BRANDS.has(brand))) {
      return "video";
    }
  }
  return null;
}

function contentKind(contentType, bytes) {
  const mediaKind = mediaKindFromBytes(bytes);
  if (contentType.startsWith("image/") || contentType.startsWith("video/")) {
    return mediaKind;
  }
  if (!UNRELIABLE_CONTENT_TYPES.has(contentType)) return "document";
  return mediaKind;
}

function isHtmlResponse(contentType, bytes) {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    return true;
  }
  const prefix = new TextDecoder()
    .decode(bytes.subarray(0, 512))
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

async function readResponsePrefix(response, signal) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let complete = false;
  try {
    while (length < ARTIFACT_READ_LIMIT_BYTES) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      if (!value || value.length === 0) continue;
      const remaining = ARTIFACT_READ_LIMIT_BYTES - length;
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
  return prefix;
}

async function verifyArtifact(artifact, fetchImpl, token, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers({
    Accept: "*/*",
    Range: `bytes=0-${ARTIFACT_READ_LIMIT_BYTES - 1}`,
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  try {
    const response = await withAbort(
      fetchImpl(artifact.url, {
        headers,
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (!response.ok) {
      return {
        status: "artifact-http-error",
        detail: `HTTP ${response.status}`,
      };
    }

    const bytes = await readResponsePrefix(response, controller.signal);
    if (bytes.length === 0) {
      return {
        status: "artifact-empty",
        detail: "response body is empty",
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

    const actualKind = contentKind(contentType, bytes);
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
    return { status: "ok" };
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
  // This standalone script runs outside Turbo task caching; credentials affect
  // transport access, never the deterministic evidence verdict.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: optional standalone CLI credential
  const githubToken = process.env.GITHUB_TOKEN;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: optional standalone CLI credential
  const ghToken = process.env.GH_TOKEN;
  const token = options.token ?? githubToken ?? ghToken ?? "";
  const rows = extractEvidenceRows(String(body ?? ""));
  const references = [];
  const uniqueArtifacts = new Map();
  const limitFindings = [];

  for (const { id, label } of requiredRows) {
    const rowText = rows.get(id);
    if (rowText === undefined) continue;
    const rowArtifacts = trustedArtifacts(rowText);
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
    verifyArtifact(artifact, fetchImpl, token, timeoutMs),
  );
  const resultsByIdentity = new Map(
    artifacts.map((artifact, index) => [artifact.identity, results[index]]),
  );
  const findings = references.map(({ id, identity, label, url }) => {
    const result = resultsByIdentity.get(identity);
    return {
      id,
      label,
      url,
      ...result,
    };
  });
  return {
    ok: findings.every((finding) => finding.status === "ok"),
    findings,
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

export function runSelfTest() {
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
        "domain-artifacts": `- [ ] OCR text readout: ${dl("pr-evidence-3", "16367-ocr.jsonl")}`,
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
  const retiredEvidenceFiles = findRetiredRepoEvidenceFiles(changedFiles);
  const evaluation = evaluatePrEvidence(body, REQUIRED_EVIDENCE_ROWS, {
    labels,
    changedFiles,
    addedFiles,
  });
  const verification = await verifyReferencedArtifacts(body);
  const findings = combineVerificationFindings(
    evaluation.findings,
    verification.findings,
  );
  const allOk =
    evaluation.ok && verification.ok && retiredEvidenceFiles.length === 0;

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
not a link to the PR or /checks page); every other row needs an artifact link
or 'N/A - <reason>'. A wholly-new surface may N/A the before-screenshots row.
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
