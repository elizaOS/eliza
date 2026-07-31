#!/usr/bin/env node
/**
 * Builds a stable, read-only inventory of open elizaOS issues and pull requests
 * for contribution selection. GitHub pagination stays behind one GET-only
 * adapter so callers and tests can verify that this script never mutates state.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MODEL_DISCLOSURE_PREFIX = "AI provider/model:";
export const REQUIRED_EVIDENCE_ROWS = [
  "before-screenshots",
  "after-screenshots",
  "walkthrough-video",
  "backend-logs",
  "frontend-logs",
  "llm-trajectory",
  "domain-artifacts",
];
export const CLAIM_RECENCY_DAYS = 7;

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLACEHOLDER_RE =
  /^(?:n\/?a|none|unknown|unspecified|tbd|todo|null|model|provider|<[^>]+>|\[[^\]]+\])$/i;
const GENERIC_PROVIDER_IDS = new Set([
  "ai",
  "model",
  "n-a",
  "n.a",
  "na",
  "none",
  "provider",
]);
const GENERIC_MODEL_IDS = new Set([
  "ai",
  "claude",
  "gemini",
  "gpt",
  "llama",
  "model",
  "na",
  "none",
]);
const ISSUE_CLAIM_RE = /^CLAIMING\s*:/i;
const REVIEW_CLAIM_RE = /^CLAIMING\s+REVIEW\s*:/i;
const CONTRIBUTION_CLAIM_RE = /^CLAIMING(?:\s+REVIEW|\s+LEVER)?\s*:/i;
const AI_PROVENANCE_DECLARATION_RE =
  /^(?:AI provider\/model\s*:|AI assistance\s*:\s*yes\b|Models?(?:\s+used)?\s*:|Model\(s\)\s+used\s*:|Client\s*\/\s*agent tooling\s*:|Contribution skill revision\s*:)/i;
const AI_PROVENANCE_MARKER_LINE_RE =
  /^<!--\s*eliza-computer-attribution:v1\b[^\r\n]*-->\s*$/i;
const HUMAN_ONLY_CLAIM_FOOTER_RE =
  /(?:^|\r?\n)\s*AI assistance:\s*no\s*[-\u2013\u2014]\s*human-only claim\s*\r?\n\s*Attribution status:\s*self-reported\s*$/i;
const HUMAN_ONLY_PR_RE =
  /^(?:[-*]\s*)?AI assistance:\s*`?no\s*[-\u2013\u2014]\s*human-only contribution`?\s*$/i;
const ISSUE_CLAIM_LABEL_RE =
  /^(?:claimed|in[- ]progress|status:\s*(?:claimed|in[- ]progress))$/i;
const REVIEW_CLAIM_LABEL_RE =
  /^(?:review[- ]claimed|review:\s*claimed|review[- ]in[- ]progress)$/i;
const SENSITIVE_LABEL_RE =
  /(?:^|[-_ ])(?:security|vulnerability|credential[-_ ]?leak|secret[-_ ]?leak|cve)(?:$|[-_ ])/i;
const EVIDENCE_MARKER_RE = /<!--\s*evidence-row:([a-z0-9-]+)\s*-->/gi;
const NA_WITH_REASON_RE =
  /\bN\/?A\b\s*[-:\u2013\u2014]\s*(?!<[^>]+>)(?!\[[^\]]+\])([^\r\n]+)/i;
const CLAIM_WINDOW_MS = CLAIM_RECENCY_DAYS * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const FULL_COMMIT_RE = /^[a-f0-9]{40}$/i;
const DOMAIN_ARTIFACT_HOSTS = new Set([
  "arbiscan.io",
  "basescan.org",
  "etherscan.io",
  "polygonscan.com",
  "sepolia.etherscan.io",
  "solscan.io",
]);

function asRecord(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be a JSON object`);
  }
  return value;
}

function asArrayField(record, field, context) {
  if (!Array.isArray(record[field])) {
    throw new TypeError(`${context}.${field} must be an array`);
  }
  return record[field];
}

function asNumberField(record, field, context) {
  if (!Number.isInteger(record[field])) {
    throw new TypeError(`${context}.${field} must be an integer`);
  }
  return record[field];
}

function asStringField(record, field, context) {
  if (typeof record[field] !== "string") {
    throw new TypeError(`${context}.${field} must be a string`);
  }
  return record[field];
}

function nullableText(value, context) {
  if (value === null) return "";
  if (typeof value !== "string") {
    throw new TypeError(`${context} must be a string or null`);
  }
  return value;
}

function isoTime(value, context) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${context} must be an ISO timestamp`);
  }
  return value;
}

function optionalIsoTime(value, context) {
  if (value === null) return null;
  return isoTime(value, context);
}

function nowTime(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Report time must be a valid Date");
  }
  return value.getTime();
}

function isRecent(timestamp, referenceTime) {
  const time = Date.parse(timestamp);
  return (
    time >= referenceTime - CLAIM_WINDOW_MS &&
    time <= referenceTime + CLOCK_SKEW_MS
  );
}

function declarationLineRecords(source) {
  const text = nullableText(source, "declaration source");
  const records = [];
  let fence = null;
  let offset = 0;
  while (offset <= text.length) {
    const newline = text.indexOf("\n", offset);
    const physicalEnd = newline === -1 ? text.length : newline;
    const raw = text.slice(offset, physicalEnd);
    const sourceLine = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const fenceMatch = sourceLine.match(
      /^\s{0,3}(?:(?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/,
    );
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = { character: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        fenceMatch[2].trim().length === 0
      ) {
        fence = null;
      }
      if (newline === -1) break;
      offset = newline + 1;
      continue;
    }
    if (
      fence !== null ||
      /^\s{0,3}>/.test(sourceLine) ||
      /^(?:\t| {4})/.test(sourceLine)
    ) {
      if (newline === -1) break;
      offset = newline + 1;
      continue;
    }
    const line = sourceLine
      .trim()
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replaceAll("**", "")
      .replaceAll("__", "");
    if (!line.startsWith("`")) {
      records.push({
        end: offset + sourceLine.length,
        normalized: line,
        start: offset,
      });
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
  return records;
}

function declarationLines(source) {
  return declarationLineRecords(source).map((record) => record.normalized);
}

function hasClaimSignal(source, pattern) {
  return declarationLines(source).some((line) => pattern.test(line));
}

function hasHumanOnlyClaimFooter(source) {
  const text = nullableText(source, "claim footer");
  const records = declarationLineRecords(text).filter(
    (record) => record.normalized.length > 0,
  );
  const terminal = records.at(-1);
  return (
    terminal !== undefined &&
    HUMAN_ONLY_CLAIM_FOOTER_RE.test(
      records
        .slice(-2)
        .map((record) => record.normalized)
        .join("\n"),
    ) &&
    text.slice(terminal.end).trim().length === 0
  );
}

function hasHumanOnlyPullRequestDeclaration(source) {
  return declarationLines(source).some((line) => HUMAN_ONLY_PR_RE.test(line));
}

function identifierKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isGenericProvider(value) {
  return GENERIC_PROVIDER_IDS.has(identifierKey(value));
}

function isGenericModel(value) {
  const segments = value.split("/");
  return (
    GENERIC_MODEL_IDS.has(identifierKey(value)) ||
    GENERIC_MODEL_IDS.has(identifierKey(segments.at(-1) ?? ""))
  );
}

function hasAiProvenanceSignal(source) {
  return declarationLines(source).some(
    (line) =>
      AI_PROVENANCE_DECLARATION_RE.test(line) ||
      AI_PROVENANCE_MARKER_LINE_RE.test(line),
  );
}

function accountLogin(account) {
  if (account === null) return "ghost";
  const record = asRecord(account, "account");
  return asStringField(record, "login", "account");
}

function labelNames(item, context) {
  return asArrayField(item, "labels", context).map((value, index) => {
    if (typeof value === "string") return value;
    return asStringField(
      asRecord(value, `${context}.labels[${index}]`),
      "name",
      `${context}.labels[${index}]`,
    );
  });
}

function compareByNumber(left, right) {
  return left.number - right.number;
}

function compareComment(left, right) {
  return left.id - right.id || left.url.localeCompare(right.url);
}

export function parsePaginatedJson(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new TypeError("gh --slurp output must be an array of pages");
  }
  return parsed.flatMap((page, index) => {
    if (!Array.isArray(page)) {
      throw new TypeError(`gh page ${index + 1} must be an array`);
    }
    return page;
  });
}

export function readGhPages(endpoint, spawn = spawnSync) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new TypeError("GitHub endpoint must be a non-empty string");
  }
  const args = ["api", "--method", "GET", "--paginate", "--slurp", endpoint];
  const result = spawn("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail =
      typeof result.stderr === "string" && result.stderr.trim().length > 0
        ? `: ${result.stderr.trim()}`
        : "";
    throw new Error(`gh api failed for ${endpoint}${detail}`);
  }
  if (typeof result.stdout !== "string") {
    throw new TypeError("gh api did not return text output");
  }
  return parsePaginatedJson(result.stdout);
}

export function parseModelDisclosure(text) {
  const body = nullableText(text, "disclosure text");
  for (const line of declarationLines(body)) {
    const match = line.match(/^AI provider\/model\s*:\s*(.+)$/i);
    if (!match) continue;
    const pair = match[1].match(/^(.+?)\s+\/\s+(.+)$/);
    if (!pair) return null;
    const provider = pair[1].trim();
    const model = pair[2].trim();
    if (
      provider.length === 0 ||
      model.length === 0 ||
      isGenericProvider(provider) ||
      isGenericModel(model) ||
      PLACEHOLDER_RE.test(provider) ||
      PLACEHOLDER_RE.test(model) ||
      /[<>[\]]/.test(provider) ||
      /[<>[\]]/.test(model)
    ) {
      return null;
    }
    return { provider, model };
  }
  return null;
}

export function isBotAccount(account) {
  if (account === null) return false;
  const record = asRecord(account, "account");
  const login = asStringField(record, "login", "account");
  if (record.type !== undefined && typeof record.type !== "string") {
    throw new TypeError("account.type must be a string when present");
  }
  return (
    String(record.type).toLowerCase() === "bot" ||
    /\[bot\]$|(?:^|[-_])bot$/i.test(login) ||
    /^(?:dependabot|renovate)(?:\[bot\])?$/i.test(login)
  );
}

function normalizeComment(value, kind, index) {
  const context = `${kind}[${index}]`;
  const record = asRecord(value, context);
  return {
    id: asNumberField(record, "id", context),
    kind,
    url: asStringField(record, "html_url", context),
    author: accountLogin(record.user),
    bot: isBotAccount(record.user),
    body: nullableText(record.body, `${context}.body`),
    createdAt: isoTime(record.created_at, `${context}.created_at`),
  };
}

function normalizeComments(values, kind) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${kind} response must be an array`);
  }
  return values
    .map((value, index) => normalizeComment(value, kind, index))
    .sort(compareComment);
}

function normalizeReview(value, index) {
  const context = `review[${index}]`;
  const record = asRecord(value, context);
  const commitId = nullableText(record.commit_id, `${context}.commit_id`);
  if (commitId.length > 0 && !FULL_COMMIT_RE.test(commitId)) {
    throw new TypeError(
      `${context}.commit_id must be a full commit SHA or null`,
    );
  }
  return {
    id: asNumberField(record, "id", context),
    kind: "review",
    url: asStringField(record, "html_url", context),
    author: accountLogin(record.user),
    bot: isBotAccount(record.user),
    body: nullableText(record.body, `${context}.body`),
    createdAt: optionalIsoTime(record.submitted_at, `${context}.submitted_at`),
    state: asStringField(record, "state", context).toUpperCase(),
    commitId: commitId.length === 0 ? null : commitId.toLowerCase(),
  };
}

function normalizeReviews(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("review response must be an array");
  }
  return values
    .map((value, index) => normalizeReview(value, index))
    .sort(compareComment);
}

export function auditCommentDisclosures(comments) {
  return comments
    .filter(
      (comment) =>
        !comment.bot &&
        comment.body.trim().length > 0 &&
        (hasClaimSignal(comment.body, CONTRIBUTION_CLAIM_RE) ||
          hasAiProvenanceSignal(comment.body)) &&
        !hasHumanOnlyClaimFooter(comment.body) &&
        parseModelDisclosure(comment.body) === null,
    )
    .map(({ id, kind, url, author }) => ({ id, kind, url, author }));
}

export function extractEvidenceRows(body) {
  const source = nullableText(body, "PR body");
  const markers = [...source.matchAll(EVIDENCE_MARKER_RE)].map((match) => ({
    id: match[1].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const rows = new Map();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const next = markers[index + 1];
    rows.set(
      marker.id,
      boundEvidenceRow(
        source.slice(marker.end, next ? next.start : source.length),
      ),
    );
  }
  return rows;
}

function boundEvidenceRow(block) {
  const lines = block.split(/\r?\n/);
  const row = [];
  let started = false;
  let detailsDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!started) {
      if (line.trim().length === 0) continue;
      started = true;
      row.push(line);
      detailsDepth = Math.max(
        0,
        detailsDepth +
          (line.match(/<details\b/gi) ?? []).length -
          (line.match(/<\/details>/gi) ?? []).length,
      );
      continue;
    }
    const nextContent = lines
      .slice(index + 1)
      .find((candidate) => candidate.trim().length > 0);
    const blankBeforeDetails =
      line.trim().length === 0 &&
      detailsDepth === 0 &&
      /^<details\b/i.test(nextContent?.trim() ?? "");
    if (
      detailsDepth === 0 &&
      !blankBeforeDetails &&
      (line.trim().length === 0 ||
        /^#/.test(line.trim()) ||
        (/^[-*]\s/.test(line) && !/^\s/.test(line)))
    ) {
      break;
    }
    row.push(line);
    detailsDepth = Math.max(
      0,
      detailsDepth +
        (line.match(/<details\b/gi) ?? []).length -
        (line.match(/<\/details>/gi) ?? []).length,
    );
  }
  return row.join("\n").trim();
}

function extractUrls(text) {
  const urls = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    try {
      urls.push(new URL(raw));
    } catch {
      // error-policy:J3 Malformed contribution text is not an evidence URL.
    }
  }
  return urls;
}

function isUserAttachment(url) {
  return (
    url.protocol === "https:" &&
    url.hostname.toLowerCase() === "github.com" &&
    /^\/user-attachments\/assets\/[a-z0-9-]+$/i.test(url.pathname)
  );
}

function isAllowedRepositoryArtifact(url) {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "raw.githubusercontent.com") {
    return (
      segments.length >= 4 &&
      segments[0].toLowerCase() === "elizaos" &&
      segments[1].toLowerCase() === "eliza" &&
      FULL_COMMIT_RE.test(segments[2])
    );
  }
  if (host !== "github.com") return false;
  return (
    (segments.length >= 5 &&
      segments[0].toLowerCase() === "elizaos" &&
      segments[1].toLowerCase() === "eliza" &&
      segments[2] === "blob" &&
      FULL_COMMIT_RE.test(segments[3])) ||
    (segments.length === 7 &&
      segments[0].toLowerCase() === "elizaos" &&
      segments[1].toLowerCase() === "eliza" &&
      segments[2] === "actions" &&
      segments[3] === "runs" &&
      /^\d+$/.test(segments[4]) &&
      segments[5] === "artifacts" &&
      /^\d+$/.test(segments[6]))
  );
}

function isAllowedDomainArtifact(url) {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!DOMAIN_ARTIFACT_HOSTS.has(host)) return false;
  if (host === "solscan.io") {
    return /^\/tx\/[1-9A-HJ-NP-Za-km-z]{32,100}$/i.test(url.pathname);
  }
  return /^\/(?:tx|transaction)\/0x[a-f0-9]{64}$/i.test(url.pathname);
}

function hasAllowedEvidenceUrl(rowId, row) {
  return extractUrls(row).some(
    (url) =>
      isUserAttachment(url) ||
      isAllowedRepositoryArtifact(url) ||
      (rowId === "domain-artifacts" && isAllowedDomainArtifact(url)),
  );
}

function backendLogLikeLine(line) {
  if (
    /^(?:\d{4}-\d{2}-\d{2}T\S+\s+)?(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)?\s*\[[A-Z][A-Za-z0-9_.-]{2,}\]\s+\S/.test(
      line,
    )
  ) {
    return true;
  }
  const structuredKeys = new Set(
    [...line.matchAll(/"(time|timestamp|level|message)"\s*:/gi)].map((match) =>
      match[1].toLowerCase(),
    ),
  );
  return structuredKeys.has("level") && structuredKeys.has("message");
}

function frontendLogLikeLine(line) {
  if (
    /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+https?:\/\/\S+\s+[1-5]\d\d\b/i.test(
      line,
    ) ||
    /(?:console\.(?:debug|info|log|warn|error)|\[(?:console|network)\])/i.test(
      line,
    )
  ) {
    return true;
  }
  const structuredKeys = new Set(
    [...line.matchAll(/"(method|url|status|statusCode)"\s*:/gi)].map((match) =>
      match[1].toLowerCase(),
    ),
  );
  return (
    structuredKeys.has("method") &&
    structuredKeys.has("url") &&
    (structuredKeys.has("status") || structuredKeys.has("statuscode"))
  );
}

function substantiveLogContent(content, rowId) {
  const plain = content
    .replaceAll(String.fromCodePoint(27), "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^```[^\r\n]*|```$/gm, "")
    .trim();
  if (
    plain.length < 80 ||
    /<[^>]+>|\b(?:todo|tbd|lorem ipsum|example logs?|sample logs?|logs? (?:go|are) here)\b/i.test(
      plain,
    ) ||
    /\b(?:paste|insert|replace)\b[^\r\n]{0,30}\blogs?\b/i.test(plain)
  ) {
    return false;
  }
  const lines = plain
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return false;
  const lineClassifier =
    rowId === "backend-logs" ? backendLogLikeLine : frontendLogLikeLine;
  if (lines.filter(lineClassifier).length >= 2) return true;

  const structuredKeys = new Set(
    [
      ...plain.matchAll(
        /"(time|timestamp|level|message|method|url|status|statusCode)"\s*:/gi,
      ),
    ].map((match) => match[1].toLowerCase()),
  );
  return rowId === "backend-logs"
    ? structuredKeys.has("message") &&
        structuredKeys.has("level") &&
        (structuredKeys.has("time") || structuredKeys.has("timestamp"))
    : structuredKeys.has("method") &&
        structuredKeys.has("url") &&
        (structuredKeys.has("status") || structuredKeys.has("statuscode"));
}

function hasSubstantiveInlineLogs(rowId, row) {
  if (rowId !== "backend-logs" && rowId !== "frontend-logs") return false;
  for (const match of row.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)) {
    if (substantiveLogContent(match[1], rowId)) return true;
  }
  return false;
}

function hasSpecificNotApplicableReason(row) {
  const match = row.match(NA_WITH_REASON_RE);
  if (!match) return false;
  const reason = match[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[*_`[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "");
  if (
    reason.length < 12 ||
    /https?:\/\//i.test(reason) ||
    /^(?:none|unknown|unspecified|not applicable|no reason|placeholder|tbd|todo)$/i.test(
      reason,
    ) ||
    /<[^>]+>|\[[^\]]+\]/.test(match[1])
  ) {
    return false;
  }
  return (reason.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? []).length >= 3;
}

export function auditPrEvidence(body) {
  const rows = extractEvidenceRows(body);
  const findings = REQUIRED_EVIDENCE_ROWS.map((id) => {
    if (!rows.has(id)) return { id, status: "missing" };
    const row = rows.get(id);
    return {
      id,
      status:
        hasAllowedEvidenceUrl(id, row) ||
        hasSubstantiveInlineLogs(id, row) ||
        hasSpecificNotApplicableReason(row)
          ? "ok"
          : "unsatisfied",
    };
  });
  return {
    ok: findings.every((finding) => finding.status === "ok"),
    findings,
  };
}

function itemSummary(item, context) {
  return {
    number: asNumberField(item, "number", context),
    title: asStringField(item, "title", context),
    url: asStringField(item, "html_url", context),
    author: accountLogin(item.user),
    labels: labelNames(item, context).sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

function claimReasons(item, comments, mode, context, referenceTime) {
  const reasons = [];
  const labels = labelNames(item, context);
  const claimLabel =
    mode === "issue" ? ISSUE_CLAIM_LABEL_RE : REVIEW_CLAIM_LABEL_RE;
  const matchedLabels = labels.filter((label) => claimLabel.test(label));
  if (matchedLabels.length > 0) {
    reasons.push(`labels: ${matchedLabels.sort().join(", ")}`);
  }

  if (mode === "issue") {
    const assignees = asArrayField(item, "assignees", context);
    if (assignees.length > 0) {
      reasons.push(
        `assignees: ${assignees
          .map((assignee) => accountLogin(assignee))
          .sort()
          .join(", ")}`,
      );
    }
  }

  const claimPattern = mode === "issue" ? ISSUE_CLAIM_RE : REVIEW_CLAIM_RE;
  const claimers = comments
    .filter(
      (comment) =>
        !comment.bot &&
        hasClaimSignal(comment.body, claimPattern) &&
        isRecent(comment.createdAt, referenceTime),
    )
    .map((comment) => comment.author)
    .filter((author, index, authors) => authors.indexOf(author) === index)
    .sort();
  if (claimers.length > 0)
    reasons.push(`claim comments: ${claimers.join(", ")}`);
  return reasons;
}

function requestedReviewTargets(item, context) {
  const users = asArrayField(item, "requested_reviewers", context)
    .map((value, index) => {
      const account = asRecord(
        value,
        `${context}.requested_reviewers[${index}]`,
      );
      return {
        key: `user:${accountLogin(account).toLowerCase()}`,
        label: accountLogin(account),
        bot: isBotAccount(account),
      };
    })
    .filter((target) => !target.bot);
  const teams = asArrayField(item, "requested_teams", context).map(
    (value, index) => {
      const team = asRecord(value, `${context}.requested_teams[${index}]`);
      const slug = asStringField(
        team,
        "slug",
        `${context}.requested_teams[${index}]`,
      );
      return { key: `team:${slug.toLowerCase()}`, label: `@${slug}` };
    },
  );
  return [...users, ...teams].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

function normalizeReviewRequestEvents(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("review request events response must be an array");
  }
  const events = [];
  for (let index = 0; index < values.length; index += 1) {
    const context = `review-request-event[${index}]`;
    const event = asRecord(values[index], context);
    if (asStringField(event, "event", context) !== "review_requested") {
      continue;
    }
    const reviewer =
      event.requested_reviewer == null
        ? null
        : asRecord(event.requested_reviewer, `${context}.requested_reviewer`);
    const team =
      event.requested_team == null
        ? null
        : asRecord(event.requested_team, `${context}.requested_team`);
    if (reviewer === null && team === null) {
      throw new TypeError(`${context} must identify a reviewer or team`);
    }
    events.push({
      targetKey:
        reviewer === null
          ? `team:${asStringField(team, "slug", `${context}.requested_team`).toLowerCase()}`
          : `user:${accountLogin(reviewer).toLowerCase()}`,
      createdAt: isoTime(event.created_at, `${context}.created_at`),
    });
  }
  return events;
}

function reviewRequestStatus(
  targets,
  events,
  fallbackTimestamp,
  referenceTime,
) {
  const active = [];
  const stale = [];
  for (const target of targets) {
    const latest = events
      .filter((event) => event.targetKey === target.key)
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      )[0];
    const timestamp = latest?.createdAt ?? fallbackTimestamp;
    (isRecent(timestamp, referenceTime) ? active : stale).push(target.label);
  }
  return { active: active.sort(), stale: stale.sort() };
}

function currentHeadReviewStatus(item, reviews, context) {
  const head = asRecord(item.head, `${context}.head`);
  const headSha = asStringField(head, "sha", `${context}.head`).toLowerCase();
  if (!FULL_COMMIT_RE.test(headSha)) {
    throw new TypeError(`${context}.head.sha must be a full commit SHA`);
  }
  const author = accountLogin(item.user).toLowerCase();
  const latestByReviewer = new Map();
  for (const review of reviews) {
    if (
      review.bot ||
      review.author.toLowerCase() === author ||
      review.createdAt === null
    ) {
      continue;
    }
    const key = review.author.toLowerCase();
    const previous = latestByReviewer.get(key);
    if (
      !previous ||
      Date.parse(review.createdAt) > Date.parse(previous.createdAt) ||
      (review.createdAt === previous.createdAt && review.id > previous.id)
    ) {
      latestByReviewer.set(key, review);
    }
  }

  const approved = [];
  const changesRequested = [];
  for (const review of latestByReviewer.values()) {
    if (review.commitId !== headSha) continue;
    if (review.state === "APPROVED") approved.push(review.author);
    if (review.state === "CHANGES_REQUESTED") {
      changesRequested.push(review.author);
    }
  }
  return {
    approved: approved.sort(),
    changesRequested: changesRequested.sort(),
  };
}

function issueCommentsEndpoint(repo, number) {
  return `repos/${repo}/issues/${number}/comments?per_page=100`;
}

function pullReviewsEndpoint(repo, number) {
  return `repos/${repo}/pulls/${number}/reviews?per_page=100`;
}

function pullReviewCommentsEndpoint(repo, number) {
  return `repos/${repo}/pulls/${number}/comments?per_page=100`;
}

function pullReviewRequestEventsEndpoint(repo, number) {
  return `repos/${repo}/issues/${number}/events?per_page=100`;
}

function listCommentsWhenPresent(item, countField, endpoint, kind, listPages) {
  const count = asNumberField(item, countField, `item #${item.number}`);
  return count === 0 ? [] : normalizeComments(listPages(endpoint), kind);
}

export function collectLiveReport(
  repo,
  listPages = readGhPages,
  now = new Date(),
) {
  if (!REPOSITORY_RE.test(repo)) {
    throw new TypeError("Repository must use the owner/name form");
  }
  const referenceTime = nowTime(now);

  const issueEndpoint = `repos/${repo}/issues?state=open&per_page=100&sort=created&direction=asc`;
  const pullEndpoint = `repos/${repo}/pulls?state=open&per_page=100&sort=created&direction=asc`;
  const issueItems = listPages(issueEndpoint)
    .map((value, index) => asRecord(value, `issues[${index}]`))
    .filter((item) => item.pull_request === undefined)
    .sort((left, right) => left.number - right.number);
  const pullItems = listPages(pullEndpoint)
    .map((value, index) => asRecord(value, `pulls[${index}]`))
    .sort((left, right) => left.number - right.number);

  const candidateIssues = [];
  const botIssues = [];
  const sensitiveIssues = [];
  const claimedIssues = [];
  const issueCommentAudits = [];

  for (const item of issueItems) {
    const summary = itemSummary(item, `issue #${item.number}`);
    if (isBotAccount(item.user)) {
      botIssues.push(summary);
      continue;
    }
    const comments = listCommentsWhenPresent(
      item,
      "comments",
      issueCommentsEndpoint(repo, summary.number),
      "issue-comment",
      listPages,
    );
    const missing = auditCommentDisclosures(comments);
    if (missing.length > 0) {
      issueCommentAudits.push({ ...summary, missingModelDisclosures: missing });
    }

    const labels = labelNames(item, `issue #${summary.number}`);
    if (labels.some((label) => SENSITIVE_LABEL_RE.test(label))) {
      sensitiveIssues.push({
        number: summary.number,
        url: summary.url,
        reason: "security-sensitive label",
      });
      continue;
    }
    const reasons = claimReasons(
      item,
      comments,
      "issue",
      `issue #${summary.number}`,
      referenceTime,
    );
    if (reasons.length > 0) {
      claimedIssues.push({ ...summary, claimReasons: reasons });
      continue;
    }
    candidateIssues.push(summary);
  }

  const reviewablePullRequests = [];
  const botPullRequests = [];
  const draftPullRequests = [];
  const claimedPullRequests = [];
  const reviewedPullRequests = [];
  const changesRequestedPullRequests = [];
  const pullRequestAudits = [];

  for (const item of pullItems) {
    const context = `pull request #${item.number}`;
    const summary = itemSummary(item, context);
    if (isBotAccount(item.user)) {
      botPullRequests.push(summary);
      continue;
    }
    if (typeof item.draft !== "boolean") {
      throw new TypeError(`${context}.draft must be a boolean`);
    }
    // Pull-list responses do not guarantee comment counts, so all three
    // paginated comment surfaces are read explicitly.
    const issueComments = normalizeComments(
      listPages(issueCommentsEndpoint(repo, summary.number)),
      "pr-comment",
    );
    const inlineComments = normalizeComments(
      listPages(pullReviewCommentsEndpoint(repo, summary.number)),
      "review-comment",
    );
    const reviews = normalizeReviews(
      listPages(pullReviewsEndpoint(repo, summary.number)),
    );
    const allComments = [...issueComments, ...inlineComments, ...reviews].sort(
      compareComment,
    );
    const body = nullableText(item.body, `${context}.body`);
    const requestedTargets = requestedReviewTargets(item, context);
    const requestEvents =
      requestedTargets.length === 0
        ? []
        : normalizeReviewRequestEvents(
            listPages(pullReviewRequestEventsEndpoint(repo, summary.number)),
          );
    const requestStatus = reviewRequestStatus(
      requestedTargets,
      requestEvents,
      isoTime(item.created_at, `${context}.created_at`),
      referenceTime,
    );
    const currentReviews = currentHeadReviewStatus(item, reviews, context);
    const reviewState = {
      activeRequests: requestStatus.active,
      staleRequests: requestStatus.stale,
      currentHeadApprovals: currentReviews.approved,
      currentHeadChangesRequested: currentReviews.changesRequested,
    };
    const detailedSummary = { ...summary, reviewState };
    pullRequestAudits.push({
      ...detailedSummary,
      bodyProviderModel: parseModelDisclosure(body),
      bodyHumanOnly: hasHumanOnlyPullRequestDeclaration(body),
      missingModelDisclosures: auditCommentDisclosures(allComments),
      evidence: auditPrEvidence(body),
    });

    const reasons = claimReasons(
      item,
      issueComments,
      "pull request",
      context,
      referenceTime,
    );
    if (requestStatus.active.length > 0) {
      reasons.push(
        `active review requests: ${requestStatus.active.join(", ")}`,
      );
    }
    if (item.draft) {
      draftPullRequests.push(detailedSummary);
      continue;
    }
    if (reasons.length > 0) {
      claimedPullRequests.push({ ...detailedSummary, claimReasons: reasons });
      continue;
    }
    if (currentReviews.changesRequested.length > 0) {
      changesRequestedPullRequests.push(detailedSummary);
      continue;
    }
    if (currentReviews.approved.length > 0) {
      reviewedPullRequests.push(detailedSummary);
      continue;
    }
    reviewablePullRequests.push(detailedSummary);
  }

  return {
    repository: repo,
    totals: {
      openIssues: issueItems.length,
      openPullRequests: pullItems.length,
      candidateIssues: candidateIssues.length,
      reviewablePullRequests: reviewablePullRequests.length,
    },
    candidateIssues: candidateIssues.sort(compareByNumber),
    reviewablePullRequests: reviewablePullRequests.sort(compareByNumber),
    filtered: {
      botIssues: botIssues.sort(compareByNumber),
      sensitiveIssues: sensitiveIssues.sort(compareByNumber),
      claimedIssues: claimedIssues.sort(compareByNumber),
      botPullRequests: botPullRequests.sort(compareByNumber),
      draftPullRequests: draftPullRequests.sort(compareByNumber),
      claimedPullRequests: claimedPullRequests.sort(compareByNumber),
      reviewedPullRequests: reviewedPullRequests.sort(compareByNumber),
      changesRequestedPullRequests:
        changesRequestedPullRequests.sort(compareByNumber),
    },
    audits: {
      issueComments: issueCommentAudits.sort(compareByNumber),
      pullRequests: pullRequestAudits.sort(compareByNumber),
    },
  };
}

function markdownItems(items) {
  if (items.length === 0) return "_None._";
  return items
    .map((item) => {
      const staleRequests = item.reviewState?.staleRequests ?? [];
      const suffix =
        staleRequests.length === 0
          ? ""
          : ` — stale review request: ${staleRequests.join(", ")} (reconfirm live state)`;
      return `- [#${item.number}](${item.url}) ${item.title}${suffix}`;
    })
    .join("\n");
}

export function renderMarkdown(report) {
  const lines = [
    `# elizaOS contribution report — ${report.repository}`,
    "",
    `Open issues: ${report.totals.openIssues}; unclaimed candidates: ${report.totals.candidateIssues}.`,
    `Open PRs: ${report.totals.openPullRequests}; reviewable candidates: ${report.totals.reviewablePullRequests}.`,
    "",
    "## Unclaimed issue candidates",
    "",
    markdownItems(report.candidateIssues),
    "",
    "## Reviewable pull requests",
    "",
    markdownItems(report.reviewablePullRequests),
    "",
    "## Disclosure and evidence gaps",
    "",
  ];

  const gaps = [];
  for (const issue of report.audits.issueComments) {
    gaps.push(
      `- Issue [#${issue.number}](${issue.url}): ${issue.missingModelDisclosures.length} claim or AI-provenance comment(s) lack exact provider/model disclosure.`,
    );
  }
  for (const pull of report.audits.pullRequests) {
    const details = [];
    if (pull.bodyProviderModel === null && !pull.bodyHumanOnly) {
      details.push("PR body lacks exact provider/model disclosure");
    }
    if (pull.missingModelDisclosures.length > 0) {
      details.push(
        `${pull.missingModelDisclosures.length} claim or AI-provenance comment(s) lack disclosure`,
      );
    }
    const evidenceGaps = pull.evidence.findings
      .filter((finding) => finding.status !== "ok")
      .map((finding) => `${finding.id}=${finding.status}`);
    if (evidenceGaps.length > 0) {
      details.push(`evidence ${evidenceGaps.join(", ")}`);
    }
    if (details.length > 0) {
      gaps.push(`- PR [#${pull.number}](${pull.url}): ${details.join("; ")}.`);
    }
  }
  lines.push(gaps.length > 0 ? gaps.join("\n") : "_No audited gaps._");
  lines.push(
    "",
    `_Read-only heuristic report: comment claims and review requests expire after ${CLAIM_RECENCY_DAYS} days unless durable repository state remains. Verify live Project state and newest comments before claiming._`,
    "",
  );
  return lines.join("\n");
}

export function parseCliArguments(args) {
  const options = { repo: "elizaOS/eliza", json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--repo") {
      index += 1;
      if (index >= args.length) {
        throw new TypeError("--repo requires an owner/name value");
      }
      options.repo = args[index];
    } else if (argument.startsWith("--repo=")) {
      options.repo = argument.slice("--repo=".length);
    } else {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
  }
  if (!REPOSITORY_RE.test(options.repo)) {
    throw new TypeError("--repo must use the owner/name form");
  }
  return options;
}

export function usage() {
  return `Usage: node scripts/live-report.mjs [options]

Read and paginate open GitHub issues and pull requests without changing them.

Options:
  --repo <owner/name>  Repository to inspect (default: elizaOS/eliza)
  --json               Print stable machine-readable JSON
  --help, -h           Show this help
`;
}

export function main(args = process.argv.slice(2)) {
  const options = parseCliArguments(args);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = collectLiveReport(options.repo);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMarkdown(report),
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  existsSync(process.argv[1]) &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(process.argv[1]);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 The CLI boundary turns a failed read/audit into a non-zero exit.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`contribute-to-eliza report failed: ${message}\n`);
    process.exitCode = 1;
  }
}
