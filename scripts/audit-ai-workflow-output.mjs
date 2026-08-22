#!/usr/bin/env node
/**
 * Audits GitHub text written by repository AI workflows whose `GITHUB_TOKEN`
 * writes cannot trigger the normal attribution workflow. A pre-action snapshot
 * establishes the trusted boundary; a separate read-only job compares current
 * issue and pull-request records, then applies the canonical comment validator
 * to every attributable mutation.
 *
 * GitHub REST does not expose the last editor of an issue body or recover a
 * comment deleted before the audit reads it. Repository-scoped callers
 * therefore permit creation and comments, not edits or deletion. The audit
 * considers only writes carrying both its machine marker and exact lane;
 * workflow-source tests require those identifiers at the write boundary.
 */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { evaluateCommentAttribution } from "./check-agent-comment-attribution.mjs";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const MAX_SNAPSHOT_CHARACTERS = 400_000;
const REPOSITORY_RE =
  /^[a-z0-9](?:[a-z0-9_.-]{0,99})\/[a-z0-9](?:[a-z0-9_.-]{0,99})$/i;
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})?(?:\[bot\])?$/i;
const LANE_RE = /^[a-z0-9][a-z0-9-]{1,48}$/i;
// Accepts both marker generations: the legacy v1 footer and the signed v2
// run receipt emitted by the published contribute-to-eliza skill.
const ATTRIBUTION_MARKER_RE =
  /^<!--\s*(?:eliza-computer-attribution:v1|elizaos-contribution-attribution:v2)\b[^\r\n]*-->\s*$/im;

function bodyHash(body) {
  return createHash("sha256")
    .update(String(body ?? ""), "utf8")
    .digest("hex");
}

function bodyValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw new TypeError("GitHub text body must be a string or null");
  }
  return value;
}

function issueNumberFromUrl(value) {
  const match = String(value ?? "").match(/\/issues\/([1-9][0-9]*)$/);
  return match ? Number(match[1]) : null;
}

function pullNumberFromUrl(value) {
  const match = String(value ?? "").match(/\/pulls\/([1-9][0-9]*)$/);
  return match ? Number(match[1]) : null;
}

function makeRecord({
  type,
  id,
  number,
  body,
  author,
  authorType,
  createdAt,
  updatedAt,
  url,
}) {
  const text = bodyValue(body);
  return {
    key: `${type}:${id}`,
    type,
    id: String(id),
    number,
    body: text,
    bodyHash: bodyHash(text),
    author: String(author ?? ""),
    authorType: String(authorType ?? ""),
    createdAt: String(createdAt ?? ""),
    updatedAt: String(updatedAt ?? createdAt ?? ""),
    url: String(url ?? ""),
  };
}

function issueBodyRecord(issue) {
  return makeRecord({
    type: "issue-body",
    id: issue.number,
    number: issue.number,
    body: issue.body,
    author: issue.user?.login,
    authorType: issue.user?.type,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: issue.html_url,
  });
}

function issueCommentRecord(comment) {
  return makeRecord({
    type: "issue-comment",
    id: comment.id,
    number: issueNumberFromUrl(comment.issue_url),
    body: comment.body,
    author: comment.user?.login,
    authorType: comment.user?.type,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    url: comment.html_url,
  });
}

function reviewRecord(review, number) {
  return makeRecord({
    type: "review",
    id: review.id,
    number,
    body: review.body,
    author: review.user?.login,
    authorType: review.user?.type,
    createdAt: review.submitted_at,
    updatedAt: review.submitted_at,
    url: review.html_url,
  });
}

function reviewCommentRecord(comment, fallbackNumber = null) {
  return makeRecord({
    type: "review-comment",
    id: comment.id,
    number: pullNumberFromUrl(comment.pull_request_url) ?? fallbackNumber,
    body: comment.body,
    author: comment.user?.login,
    authorType: comment.user?.type,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    url: comment.html_url,
  });
}

function snapshotRecord(record) {
  // Job outputs have a hard size ceiling. Only the stable identity and content
  // digest cross the job boundary; untrusted bodies and API metadata do not.
  return { key: record.key, bodyHash: record.bodyHash };
}

function recordMap(records) {
  const entries = new Map();
  for (const record of records) {
    if (entries.has(record.key)) {
      throw new Error(`GitHub API returned duplicate record ${record.key}`);
    }
    entries.set(record.key, record);
  }
  return entries;
}

function validateRepository(repository) {
  if (!REPOSITORY_RE.test(repository)) {
    throw new TypeError("Repository must use the owner/name form");
  }
  return repository;
}

function validateTargetNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("Target number must be a positive integer");
  }
  return number;
}

function validateScope(scope) {
  if (scope !== "target" && scope !== "repository") {
    throw new TypeError("Audit scope must be target or repository");
  }
  return scope;
}

function ensureArray(value, endpoint) {
  if (!Array.isArray(value)) {
    throw new TypeError(`GitHub API ${endpoint} did not return an array`);
  }
  return value;
}

export function createGithubReader({
  repository,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const checkedRepository = validateRepository(repository);
  if (typeof token !== "string" || token.length < 1) {
    throw new TypeError("A GitHub token is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required");
  }

  async function get(endpoint, query = {}) {
    if (!endpoint.startsWith("/") || endpoint.includes("://")) {
      throw new TypeError("GitHub endpoint must be repository-relative");
    }
    const url = new URL(
      `${API_ROOT}/repos/${encodeURI(checkedRepository)}${endpoint}`,
    );
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "eliza-ai-attribution-audit",
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
    if (!response.ok) {
      const requestId =
        response.headers.get("x-github-request-id") ?? "unknown";
      throw new Error(
        `GitHub GET ${url.pathname} failed with ${response.status} (request ${requestId})`,
      );
    }
    return response.json();
  }

  async function getAll(endpoint, query = {}) {
    const values = [];
    for (let page = 1; ; page += 1) {
      const batch = ensureArray(
        await get(endpoint, { ...query, per_page: PAGE_SIZE, page }),
        endpoint,
      );
      values.push(...batch);
      if (batch.length < PAGE_SIZE) return values;
    }
  }

  return { get, getAll };
}

async function collectPullRecords(reader, number) {
  const [reviews, reviewComments] = await Promise.all([
    reader.getAll(`/pulls/${number}/reviews`),
    reader.getAll(`/pulls/${number}/comments`),
  ]);
  return [
    ...reviews.map((review) => reviewRecord(review, number)),
    ...reviewComments.map((comment) => reviewCommentRecord(comment, number)),
  ];
}

export async function collectTargetRecords(reader, number) {
  const targetNumber = validateTargetNumber(number);
  const issue = await reader.get(`/issues/${targetNumber}`);
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    throw new TypeError("GitHub issue endpoint did not return an object");
  }
  const comments = await reader.getAll(`/issues/${targetNumber}/comments`);
  const records = comments.map(issueCommentRecord);
  if (issue.pull_request) {
    records.push(...(await collectPullRecords(reader, targetNumber)));
  } else {
    records.push(issueBodyRecord(issue));
  }
  return recordMap(records);
}

export async function collectRepositoryRecords(reader, since) {
  const [issues, issueComments, reviewComments] = await Promise.all([
    reader.getAll("/issues", {
      state: "all",
      since,
      sort: "updated",
      direction: "asc",
    }),
    reader.getAll("/issues/comments", {
      since,
      sort: "updated",
      direction: "asc",
    }),
    reader.getAll("/pulls/comments", {
      since,
      sort: "updated",
      direction: "asc",
    }),
  ]);

  const records = [
    ...issues.filter((issue) => !issue.pull_request).map(issueBodyRecord),
    ...issueComments.map(issueCommentRecord),
    ...reviewComments.map((comment) => reviewCommentRecord(comment)),
  ];
  const pullNumbers = [
    ...new Set(
      issues
        .filter((issue) => issue.pull_request)
        .map((issue) => validateTargetNumber(issue.number)),
    ),
  ];
  for (const number of pullNumbers) {
    const reviews = await reader.getAll(`/pulls/${number}/reviews`);
    records.push(...reviews.map((review) => reviewRecord(review, number)));
  }
  return recordMap(records);
}

export function encodeSnapshot(snapshot) {
  const encoded = gzipSync(JSON.stringify(snapshot), { level: 9 }).toString(
    "base64url",
  );
  if (encoded.length > MAX_SNAPSHOT_CHARACTERS) {
    throw new Error(
      `Attribution snapshot exceeds the ${MAX_SNAPSHOT_CHARACTERS}-character job-output limit`,
    );
  }
  return encoded;
}

export function decodeSnapshot(value) {
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError("Attribution snapshot is missing");
  }
  if (value.length > MAX_SNAPSHOT_CHARACTERS) {
    throw new TypeError("Attribution snapshot exceeds the safe encoded limit");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(
      gunzipSync(Buffer.from(value, "base64url"), {
        maxOutputLength: 4_000_000,
      }).toString("utf8"),
    );
  } catch (error) {
    // error-policy:J2 Preserve the decode failure as the cause of the typed
    // snapshot-boundary error.
    throw new TypeError("Attribution snapshot is not valid encoded JSON", {
      cause: error,
    });
  }
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    snapshot.version !== 1
  ) {
    throw new TypeError("Attribution snapshot has an unsupported shape");
  }
  validateRepository(snapshot.repository);
  validateScope(snapshot.scope);
  if (snapshot.scope === "target") validateTargetNumber(snapshot.number);
  if (
    typeof snapshot.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    typeof snapshot.windowStart !== "string" ||
    !Number.isFinite(Date.parse(snapshot.windowStart)) ||
    !Array.isArray(snapshot.records)
  ) {
    throw new TypeError("Attribution snapshot boundary is malformed");
  }
  for (const record of snapshot.records) {
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.key !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.bodyHash)
    ) {
      throw new TypeError("Attribution snapshot contains a malformed record");
    }
  }
  return snapshot;
}

export async function createAuditSnapshot({
  repository,
  scope,
  number,
  token,
  fetchImpl,
  now = () => new Date(),
}) {
  const checkedScope = validateScope(scope);
  const reader = createGithubReader({ repository, token, fetchImpl });
  const startedAt = now();
  if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
    throw new TypeError("Audit clock returned an invalid date");
  }
  const windowStart = new Date(startedAt.getTime() - 60_000).toISOString();
  const records =
    checkedScope === "target"
      ? await collectTargetRecords(reader, number)
      : await collectRepositoryRecords(reader, windowStart);
  const capturedAt = now();
  if (!(capturedAt instanceof Date) || !Number.isFinite(capturedAt.getTime())) {
    throw new TypeError("Audit clock returned an invalid date");
  }
  return {
    version: 1,
    repository: validateRepository(repository),
    scope: checkedScope,
    number:
      checkedScope === "target" ? validateTargetNumber(number) : undefined,
    capturedAt: capturedAt.toISOString(),
    windowStart,
    records: [...records.values()].map(snapshotRecord),
  };
}

function mutationWasAuthoredBy(record, expectedAuthors) {
  return expectedAuthors.has(record.author.toLowerCase());
}

export function findWorkflowMutations(
  snapshot,
  currentRecords,
  expectedAuthors,
  expectedLane,
) {
  if (!LANE_RE.test(expectedLane)) {
    throw new TypeError("Expected lane has an invalid format");
  }
  const authors = new Set(
    expectedAuthors.map((author) => {
      if (!LOGIN_RE.test(author)) {
        throw new TypeError(`Invalid expected GitHub author: ${author}`);
      }
      return author.toLowerCase();
    }),
  );
  if (authors.size === 0) {
    throw new TypeError("At least one expected GitHub author is required");
  }
  const previous = new Map(
    snapshot.records.map((record) => [record.key, record]),
  );
  const boundaryMs = Date.parse(snapshot.capturedAt);
  const mutations = [];
  for (const record of currentRecords.values()) {
    const before = previous.get(record.key);
    if (before?.bodyHash === record.bodyHash) continue;
    if (
      !ATTRIBUTION_MARKER_RE.test(record.body) ||
      exactLaneCount(record.body, expectedLane) !== 1
    ) {
      continue;
    }
    if (record.type === "issue-body") {
      if (
        !before &&
        (!mutationWasAuthoredBy(record, authors) ||
          Date.parse(record.createdAt) < boundaryMs - 2_000)
      ) {
        continue;
      }
      // GitHub's issue representation exposes the creator, not the last editor.
      // A changed in-scope body is therefore conservatively attributed to the
      // only write-capable job between the two trusted snapshots.
      mutations.push(record);
      continue;
    }
    if (
      !before &&
      record.type === "review" &&
      Date.parse(record.createdAt) < boundaryMs - 2_000
    ) {
      continue;
    }
    if (mutationWasAuthoredBy(record, authors)) mutations.push(record);
  }
  return mutations.sort((left, right) => left.key.localeCompare(right.key));
}

function exactLaneCount(body, lane) {
  const escaped = lane.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...String(body).matchAll(
      new RegExp(`(?:^|\\n)(?:—|-)\\s*\\[${escaped}\\]\\s*$`, "gim"),
    ),
  ].length;
}

export function validateWorkflowMutations(mutations, expected) {
  const findings = [];
  if (!LANE_RE.test(expected.lane)) {
    throw new TypeError("Expected lane has an invalid format");
  }
  for (const record of mutations) {
    const result = evaluateCommentAttribution(record.body, {
      required: true,
      issueBody: record.type === "issue-body",
    });
    const errors = result.findings.map((finding) => finding.message);
    if (result.attribution?.kind !== "machine") {
      errors.push("Workflow output must use machine attribution.");
    } else {
      for (const [field, wanted, actual] of [
        ["provider", expected.provider, result.attribution.provider],
        ["model", expected.model, result.attribution.model],
        ["client", expected.client, result.attribution.client],
        [
          "skill revision",
          expected.skillRevision,
          result.attribution.skillRevision,
        ],
      ]) {
        const matches =
          field === "provider"
            ? String(actual).toLowerCase() === String(wanted).toLowerCase()
            : actual === wanted;
        if (!matches) {
          errors.push(
            `Workflow ${field} must be ${JSON.stringify(wanted)}, received ${JSON.stringify(actual)}.`,
          );
        }
      }
    }
    if (exactLaneCount(record.body, expected.lane) !== 1) {
      errors.push(`Workflow output must carry lane [${expected.lane}].`);
    }
    if (!result.ok || errors.length > 0) {
      findings.push({ key: record.key, url: record.url, errors });
    }
  }
  return { ok: findings.length === 0, findings };
}

export async function verifyAuditSnapshot({
  encodedSnapshot,
  token,
  expectedAuthors,
  expected,
  fetchImpl,
  settleAttempts = 1,
  settleDelayMs = 0,
  delayImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const snapshot = decodeSnapshot(encodedSnapshot);
  const reader = createGithubReader({
    repository: snapshot.repository,
    token,
    fetchImpl,
  });
  if (
    !Number.isSafeInteger(settleAttempts) ||
    settleAttempts < 1 ||
    settleAttempts > 10 ||
    !Number.isSafeInteger(settleDelayMs) ||
    settleDelayMs < 0 ||
    settleDelayMs > 10_000
  ) {
    throw new TypeError("Audit settling controls are outside their safe range");
  }
  const observedMutations = new Map();
  for (let attempt = 1; attempt <= settleAttempts; attempt += 1) {
    const currentRecords =
      snapshot.scope === "target"
        ? await collectTargetRecords(reader, snapshot.number)
        : await collectRepositoryRecords(reader, snapshot.windowStart);
    const mutations = findWorkflowMutations(
      snapshot,
      currentRecords,
      expectedAuthors,
      expected.lane,
    );
    for (const mutation of mutations) {
      observedMutations.set(mutation.key, mutation);
    }
    if (attempt < settleAttempts) await delayImpl(settleDelayMs);
  }
  const mutations = [...observedMutations.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  if (mutations.length > 0) {
    const validation = validateWorkflowMutations(mutations, expected);
    return {
      ok: validation.ok,
      noOp: false,
      mutations,
      findings: validation.findings,
    };
  }
  return { ok: true, noOp: true, mutations: [], findings: [] };
}

function parseArgs(argv) {
  const parsed = { command: argv[0] ?? "", authors: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new TypeError(`Invalid argument: ${flag}`);
    }
    const key = flag
      .slice(2)
      .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (key === "author") parsed.authors.push(value);
    else parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function requiredArg(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError(
      `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`,
    );
  }
  return value;
}

function integerArg(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new TypeError(`Expected a non-negative integer, received ${value}`);
  }
  return Number(value);
}

export async function runCli(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const args = parseArgs(argv);
  const token = environment.GH_TOKEN || environment.GITHUB_TOKEN || "";
  if (args.command === "snapshot") {
    const scope = requiredArg(args, "scope");
    const snapshot = await createAuditSnapshot({
      repository: requiredArg(args, "repository"),
      scope,
      number: scope === "target" ? requiredArg(args, "number") : undefined,
      token,
    });
    process.stdout.write(`${encodeSnapshot(snapshot)}\n`);
    return 0;
  }
  if (args.command === "verify") {
    const result = await verifyAuditSnapshot({
      encodedSnapshot:
        args.snapshot || environment.ATTRIBUTION_AUDIT_SNAPSHOT || "",
      token,
      expectedAuthors: args.authors,
      expected: {
        provider: requiredArg(args, "expectedProvider"),
        model: requiredArg(args, "expectedModel"),
        client: requiredArg(args, "expectedClient"),
        skillRevision: requiredArg(args, "expectedSkillRevision"),
        lane: requiredArg(args, "expectedLane"),
      },
      settleAttempts: integerArg(args.settleAttempts, 3),
      settleDelayMs: integerArg(args.settleDelayMs, 2_000),
    });
    if (result.noOp) {
      process.stdout.write(
        "No in-scope GitHub text writes were detected; attribution audit accepted the no-op run.\n",
      );
      return 0;
    }
    if (result.ok) {
      process.stdout.write(
        `Validated ${result.mutations.length} AI workflow GitHub text mutation(s).\n`,
      );
      return 0;
    }
    process.stderr.write("AI workflow output attribution is invalid:\n");
    for (const finding of result.findings) {
      process.stderr.write(
        `- ${finding.key}${finding.url ? ` (${finding.url})` : ""}\n`,
      );
      for (const error of finding.errors) {
        process.stderr.write(`  - ${error}\n`);
      }
    }
    return 1;
  }
  throw new TypeError(
    "Usage: audit-ai-workflow-output.mjs (snapshot|verify) [options]",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    // error-policy:J1 The CLI boundary reports audit failures and exits nonzero.
    .catch((error) => {
      process.stderr.write(
        `AI workflow attribution audit failed closed: ${error.message}\n`,
      );
      process.exitCode = 1;
    });
}
