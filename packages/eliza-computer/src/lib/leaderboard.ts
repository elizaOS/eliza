/**
 * Defines the public contribution snapshot and the deterministic scoring policy
 * for eliza.army. GitHub ingestion stays outside this module so fixtures can
 * prove every award, exclusion, cap, and provenance rule without network access.
 */

export const LEADERBOARD_REPOSITORY = "elizaOS/eliza" as const;
export const LEADERBOARD_SCHEMA_VERSION = "1" as const;
export const SCORE_RULE_VERSION = "eliza-computer-v2" as const;
export const SCORE_WINDOW_DAYS = 30;
export const VERIFICATION_WINDOW_DAYS = 7;
export const MATERIAL_TEST_ADDITIONS = 10;
export const MATERIAL_TEST_CHURN = 20;
export const CLAIM_MAX_AGE_DAYS = 7;

export type GitHubActorKind =
  | "Bot"
  | "Mannequin"
  | "Organization"
  | "User"
  | "Unknown";

export interface GitHubActor {
  id: string;
  login: string;
  avatarUrl: string;
  url: string;
  kind: GitHubActorKind;
}

export interface GitHubLabel {
  id: string;
  name: string;
  color: string;
}

export interface GitHubTextSource {
  id: string;
  artifactId: string;
  kind: "body" | "comment" | "review";
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: GitHubActor | null;
}

export interface PullRequestFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PullRequestReview {
  id: string;
  body: string;
  state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "DISMISSED"
    | "PENDING"
    | string;
  submittedAt: string | null;
  url: string;
  author: GitHubActor | null;
  inlineCommentCount: number;
}

export interface PullRequestRecord {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  lastEditedAt: string | null;
  mergedAt: string | null;
  isDraft: boolean;
  reviewDecision: string | null;
  author: GitHubActor | null;
  assignees: GitHubActor[];
  labels: GitHubLabel[];
  files: PullRequestFile[];
  comments: GitHubTextSource[];
  reviews: PullRequestReview[];
  closingIssueIds: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
}

export interface MergedPullRequestOutcome {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string;
  author: GitHubActor | null;
  additions: number;
  deletions: number;
}

export interface IssueRecord {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null | string;
  author: GitHubActor | null;
  assignees: GitHubActor[];
  labels: GitHubLabel[];
  comments: GitHubTextSource[];
  closedByPullRequests: Array<{
    id: string;
    number: number;
    url: string;
    mergedAt: string | null;
  }>;
}

export type EvidenceCategory =
  | "screenshot"
  | "video"
  | "logs"
  | "trajectory"
  | "domain-artifact";

export interface EvidenceFinding {
  category: EvidenceCategory;
  points: number;
  sourceIds: string[];
}

export interface EvidenceAssessment {
  points: number;
  maxPoints: 6;
  categories: EvidenceCategory[];
  findings: EvidenceFinding[];
}

export interface InvalidAttributionMarker {
  sourceId: string;
  sourceUrl: string;
  reason: string;
}

export interface ModelAttribution {
  id: string;
  sourceId: string;
  sourceUrl: string;
  artifactId: string;
  actor: GitHubActor | null;
  provider: string;
  model: string;
  identifier: string;
  client: string | null;
  skillRevision: string | null;
  format: "machine-marker" | "visible-declaration";
  status: "self-reported";
}

export interface AttributionAssessment {
  declarations: ModelAttribution[];
  invalidMarkers: InvalidAttributionMarker[];
  coverage: AttributionCoverage;
}

export interface AttributionCoverage {
  status: "complete" | "partial" | "missing" | "invalid";
  eligibleSourceCount: number;
  validSourceCount: number;
  missingSourceCount: number;
  invalidSourceCount: number;
  humanOnlySourceCount: number;
}

export type ScoreCategory =
  | "merged-pull-request"
  | "resolved-issue"
  | "material-test-change"
  | "evidence"
  | "substantive-review";

export interface ScoreEvent {
  id: string;
  actor: GitHubActor;
  category: ScoreCategory;
  points: number;
  source: {
    id: string;
    kind: "issue" | "pull-request" | "review";
    number: number;
    title: string;
    url: string;
  };
  reason: string;
}

export interface LeaderboardEntry {
  rank: number;
  actor: GitHubActor;
  score: number;
  points: {
    mergedPullRequests: number;
    resolvedIssues: number;
    materialTestChanges: number;
    evidence: number;
    substantiveReviews: number;
  };
  acceptedOutcomes: {
    mergedPullRequests: number;
    resolvedIssues: number;
    materialTestChanges: number;
    evidenceCategories: number;
    substantiveReviews: number;
  };
  rawActivity: {
    comments: number;
    reviews: number;
    commits: number;
    additions: number;
    deletions: number;
  };
  reportedModels: string[];
}

export interface WorkItemClaimStatus {
  status: "claimed" | "unclaimed";
  source: "assignee" | "label" | "claim-comment" | "none";
  kind: "implementation" | "review" | null;
  actors: GitHubActor[];
  claimedAt: string | null;
}

export interface WorkItemEvidenceStatus {
  status: "complete" | "partial" | "missing";
  points: number;
  maxPoints: 6;
  categories: EvidenceCategory[];
}

export interface WorkItemModelStatus {
  status: AttributionCoverage["status"];
  identifiers: string[];
  machineMarkerCount: number;
  invalidMarkerCount: number;
  eligibleSourceCount: number;
  validSourceCount: number;
  missingSourceCount: number;
  invalidSourceCount: number;
  humanOnlySourceCount: number;
  provenance: "self-reported" | "none";
}

export interface WorkItem {
  id: string;
  kind: "issue" | "pull-request";
  number: number;
  title: string;
  url: string;
  author: GitHubActor | null;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  priority: "urgent" | "high" | "normal" | "low";
  actionability: "actionable" | "blocked" | "draft";
  isDraft: boolean | null;
  reviewDecision: string | null;
  commentCount: number;
  claim: WorkItemClaimStatus;
  evidence: WorkItemEvidenceStatus;
  model: WorkItemModelStatus;
}

export interface LeaderboardMethodology {
  summary: string;
  scoringRules: Array<{
    id: ScoreCategory;
    points: string;
    cap: string;
    qualification: string;
  }>;
  evidenceWeights: Record<EvidenceCategory, number>;
  materialTestThreshold: {
    minimumAdditions: number;
    minimumTotalChurn: number;
    cap: string;
  };
  exclusions: string[];
  nonScoringActivity: string[];
  provenancePolicy: string;
  collectionPolicy: string;
}

export interface LeaderboardSourceMetadata {
  provider: "github-graphql";
  fetchedAt: string;
  cutoffAt: string;
  repositoryId: string;
  requestCount: number;
  searchSliceCount: number;
  rateLimit: {
    cost: number;
    consumedDuringRun?: number;
    limit: number;
    remaining: number;
    resetAt: string;
  };
  counts: {
    mergedPullRequests: number;
    detailedMergedPullRequests: number;
    closedIssues: number;
    detailedClosedIssues: number;
    resolvedIssues: number;
    openIssues: number;
    openPullRequests: number;
  };
  verificationWindow: {
    days: number;
    from: string;
    to: string;
  };
}

export interface LeaderboardSnapshot {
  schemaVersion: typeof LEADERBOARD_SCHEMA_VERSION;
  repository: typeof LEADERBOARD_REPOSITORY;
  ruleVersion: typeof SCORE_RULE_VERSION;
  generatedAt: string;
  sourceUpdatedAt: string;
  stale: false;
  window: {
    days: number;
    from: string;
    to: string;
  };
  methodology: LeaderboardMethodology;
  source: LeaderboardSourceMetadata;
  leaders: LeaderboardEntry[];
  ledger: ScoreEvent[];
  attributions: ModelAttribution[];
  invalidAttributionMarkers: InvalidAttributionMarker[];
  attributionCoverage: AttributionCoverage;
  workQueue: {
    issues: WorkItem[];
    pullRequests: WorkItem[];
  };
}

export interface LeaderboardInput {
  generatedAt: string;
  windowFrom: string;
  windowTo: string;
  sourceUpdatedAt: string;
  source: LeaderboardSourceMetadata;
  mergedPullRequestOutcomes: MergedPullRequestOutcome[];
  mergedPullRequests: PullRequestRecord[];
  closedIssueCount: number;
  resolvedIssues: IssueRecord[];
  openIssues: IssueRecord[];
  openPullRequests: PullRequestRecord[];
  verificationWindowFrom: string;
}

const EVIDENCE_WEIGHTS: Record<EvidenceCategory, number> = {
  screenshot: 1,
  video: 2,
  logs: 1,
  trajectory: 1,
  "domain-artifact": 1,
};

const CONFIRMATION_LABELS = new Set([
  "confirmed",
  "status: confirmed",
  "status: triaged",
  "triaged",
  "validated",
]);

const CLAIM_LABELS = new Set([
  "claimed",
  "in progress",
  "in-progress",
  "status: in progress",
  "status: claimed",
  "working",
]);

const BLOCKED_LABELS = new Set([
  "blocked",
  "do not merge",
  "do-not-merge",
  "needs human input",
  "needs-human-input",
  "status: blocked",
]);

const URGENT_LABELS = new Set([
  "blocker",
  "critical",
  "p0",
  "priority: critical",
  "priority: urgent",
  "urgent",
]);

const HIGH_PRIORITY_LABELS = new Set(["high priority", "p1", "priority: high"]);

const LOW_PRIORITY_LABELS = new Set([
  "low priority",
  "p3",
  "p4",
  "priority: low",
]);

const EXACT_MODEL_IDENTIFIER_PATTERN =
  /\b([a-z0-9][a-z0-9._-]{0,63})\/([a-z0-9][a-z0-9._:/-]{0,127})\b/gi;
const ATTRIBUTION_PLACEHOLDER_PATTERN =
  /<[^>]+>|\b(?:unknown|unspecified|placeholder|provider|model|tbd|todo|null)\b/i;
const FULL_SKILL_REVISION_PATTERN =
  /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}:[^\s`]+$/i;
const GENERIC_MODEL_IDENTIFIERS = new Set([
  "ai",
  "claude",
  "gemini",
  "gpt",
  "llama",
  "model",
  "na",
  "none",
]);
const GENERIC_PROVIDER_IDENTIFIERS = new Set([
  "ai",
  "model",
  "na",
  "none",
  "provider",
]);
const HUMAN_ONLY_PATTERN =
  /^\s*(?:[-*]\s*)?(?:(?:AI assistance|Attribution)\s*:\s*)?`?(?:no\s*[-—:]\s*)?human[- ]only\s+(?:comment|contribution|epic|issue|report|request|review|work)`?\s*$/im;
const ISSUE_CLAIM_PATTERN = /^CLAIMING:\s*\S/i;
const REVIEW_CLAIM_PATTERN = /^CLAIMING\s+REVIEW:\s*\S/i;
const ATTRIBUTION_DECLARATION_PATTERN =
  /^(?:AI provider\/model\s*:|AI assistance\s*:\s*yes\b|Models?(?:\s+used)?\s*:|Model\(s\)\s+used\s*:|Client\s*\/\s*agent tooling\s*:|Contribution skill revision\s*:)/i;
const ATTRIBUTION_MARKER_LINE_PATTERN =
  /^<!--\s*eliza-computer-attribution:v1\b[^\r\n]*-->\s*$/i;

interface MutableLeaderboardEntry {
  actor: GitHubActor;
  score: number;
  points: LeaderboardEntry["points"];
  acceptedOutcomes: LeaderboardEntry["acceptedOutcomes"];
  rawActivity: LeaderboardEntry["rawActivity"];
  models: Set<string>;
}

interface AttributionDeclarationLine {
  end: number;
  normalized: string;
  raw: string;
  start: number;
}

interface AttributionMarkerRecord {
  end: number;
  payload: string;
  start: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function attributionDeclarationLineRecords(
  body: string,
): AttributionDeclarationLine[] {
  const records: AttributionDeclarationLine[] = [];
  let fence: { character: "`" | "~"; length: number } | null = null;
  let offset = 0;
  while (offset <= body.length) {
    const newline = body.indexOf("\n", offset);
    const physicalEnd = newline === -1 ? body.length : newline;
    const raw = body.slice(offset, physicalEnd);
    const sourceLine = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const fenceMatch = sourceLine.match(
      /^\s{0,3}(?:(?:[-*+]|\d+[.)])\s+)?(`{3,}|~{3,})(.*)$/,
    );
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const character = marker[0] as "`" | "~";
      if (fence === null) {
        fence = { character, length: marker.length };
      } else if (
        character === fence.character &&
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
        raw: sourceLine,
        start: offset,
      });
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
  return records;
}

function attributionDeclarationLines(body: string): string[] {
  return attributionDeclarationLineRecords(body).map(
    (record) => record.normalized,
  );
}

function attributionMarkerRecords(body: string): AttributionMarkerRecord[] {
  return attributionDeclarationLineRecords(body)
    .map((record) => {
      const raw = record.raw.trim();
      const marker = raw.match(
        /^<!--\s*eliza-computer-attribution:v1\b([\s\S]*?)-->\s*$/i,
      );
      if (!marker) return null;
      const leadingWhitespace =
        record.raw.length - record.raw.trimStart().length;
      return {
        end: record.start + leadingWhitespace + raw.length,
        payload: marker[1].trim(),
        start: record.start + leadingWhitespace,
      };
    })
    .filter((record): record is AttributionMarkerRecord => record !== null);
}

function hasAttributionEligibilitySignal(body: string): boolean {
  return attributionDeclarationLines(body).some(
    (line) =>
      ATTRIBUTION_DECLARATION_PATTERN.test(line) ||
      ATTRIBUTION_MARKER_LINE_PATTERN.test(line),
  );
}

function providerSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function identifierKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isGenericProviderIdentifier(value: string): boolean {
  return GENERIC_PROVIDER_IDENTIFIERS.has(identifierKey(value));
}

function isGenericModelIdentifier(value: string): boolean {
  const segments = value.split("/");
  return (
    GENERIC_MODEL_IDENTIFIERS.has(identifierKey(value)) ||
    GENERIC_MODEL_IDENTIFIERS.has(identifierKey(segments.at(-1) ?? ""))
  );
}

function hasMarkdownLine(body: string, pattern: RegExp): boolean {
  return attributionDeclarationLines(body).some((line) => pattern.test(line));
}

function parseIsoTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return parsed;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function dedupeByNodeId<T extends { id: string }>(records: T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    if (!record.id) {
      throw new Error("GitHub record is missing its immutable node ID");
    }
    if (!byId.has(record.id)) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}

export function isBotActor(actor: GitHubActor | null): boolean {
  if (!actor) {
    return false;
  }
  if (actor.kind === "Bot") {
    return true;
  }
  return (
    /\[bot\]$/i.test(actor.login) ||
    /(?:^|[-_])bot$/i.test(actor.login) ||
    /^(?:dependabot|github-actions)$/i.test(actor.login)
  );
}

export function isRecognizedTestFile(path: string): boolean {
  const normalized = path.toLowerCase();
  if (
    normalized.includes("/__snapshots__/") ||
    normalized.includes("/fixtures/") ||
    normalized.includes("/testdata/")
  ) {
    return false;
  }
  return (
    /(^|\/)(?:__tests__|tests?|specs?|e2e)\//.test(normalized) ||
    /(?:^|[._-])(?:test|spec)\.[a-z0-9]+$/.test(normalized) ||
    /_test\.[a-z0-9]+$/.test(normalized) ||
    /\.feature$/.test(normalized)
  );
}

export function hasMaterialTestChange(files: PullRequestFile[]): boolean {
  const testFiles = files.filter((file) => isRecognizedTestFile(file.path));
  const additions = testFiles.reduce(
    (total, file) => total + file.additions,
    0,
  );
  const churn = testFiles.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
  return additions >= MATERIAL_TEST_ADDITIONS && churn >= MATERIAL_TEST_CHURN;
}

function withoutNotApplicableRows(body: string): string {
  return body
    .split("\n")
    .filter(
      (line) =>
        !/\bN\s*\/?\s*A\b\s*[-:—]/i.test(line) &&
        !/\bnot applicable\b/i.test(line),
    )
    .join("\n");
}

interface IndexedUrl {
  index: number;
  raw: string;
  url: URL;
}

const EVIDENCE_ROW_CATEGORY: Record<string, EvidenceCategory> = {
  "after-screenshots": "screenshot",
  "backend-logs": "logs",
  "before-screenshots": "screenshot",
  "domain-artifacts": "domain-artifact",
  "frontend-logs": "logs",
  "llm-trajectory": "trajectory",
  "walkthrough-video": "video",
};

const DOMAIN_ARTIFACT_HOSTS = new Set([
  "arbiscan.io",
  "basescan.org",
  "etherscan.io",
  "polygonscan.com",
  "sepolia.etherscan.io",
  "solscan.io",
]);

function extractUrls(body: string): IndexedUrl[] {
  const urls: IndexedUrl[] = [];
  for (const match of body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    try {
      urls.push({ index: match.index, raw, url: new URL(raw) });
    } catch {
      // error-policy:J3 malformed text is not an evidence URL.
    }
  }
  return urls;
}

function isUserAttachment(url: URL): boolean {
  return (
    url.hostname.toLowerCase() === "github.com" &&
    /^\/user-attachments\/assets\/[a-z0-9-]+$/i.test(url.pathname)
  );
}

function isAllowedRepositoryArtifact(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "raw.githubusercontent.com") {
    return /^\/elizaOS\/eliza\/[a-f0-9]{40}\//i.test(url.pathname);
  }
  if (host !== "github.com") {
    return false;
  }
  return (
    /^\/elizaOS\/eliza\/blob\/[a-f0-9]{40}\//i.test(url.pathname) ||
    /^\/elizaOS\/eliza\/actions\/runs\/\d+\/artifacts\/\d+\/?$/i.test(
      url.pathname,
    )
  );
}

function isAllowedDomainArtifact(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (!DOMAIN_ARTIFACT_HOSTS.has(host)) {
    return false;
  }
  if (host === "solscan.io") {
    return /^\/tx\/[1-9A-HJ-NP-Za-km-z]{32,100}$/i.test(url.pathname);
  }
  return /^\/(?:tx|transaction)\/0x[a-f0-9]{64}$/i.test(url.pathname);
}

function isAllowedArtifactUrl(url: URL, category: EvidenceCategory): boolean {
  if (isUserAttachment(url) || isAllowedRepositoryArtifact(url)) {
    return true;
  }
  return category === "domain-artifact" && isAllowedDomainArtifact(url);
}

function evidenceRows(body: string): Map<EvidenceCategory, string[]> {
  const markers = [...body.matchAll(/<!--\s*evidence-row:([a-z-]+)\s*-->/gi)];
  const rows = new Map<EvidenceCategory, string[]>();
  for (const [index, marker] of markers.entries()) {
    const category = EVIDENCE_ROW_CATEGORY[marker[1].toLowerCase()];
    if (!category) {
      continue;
    }
    const next = markers[index + 1];
    const segmentEnd = next ? next.index : body.length;
    const segment = body
      .slice(marker.index + marker[0].length, segmentEnd)
      .split(/\n(?=#{1,2}\s)/, 1)[0];
    const current = rows.get(category) ?? [];
    current.push(segment);
    rows.set(category, current);
  }
  return rows;
}

function hasContextualArtifact(
  body: string,
  category: EvidenceCategory,
  contextPattern: RegExp,
): boolean {
  for (const candidate of extractUrls(body)) {
    if (!isAllowedArtifactUrl(candidate.url, category)) {
      continue;
    }
    const context = body.slice(
      Math.max(0, candidate.index - 180),
      candidate.index + candidate.raw.length + 80,
    );
    if (contextPattern.test(context)) {
      return true;
    }
  }
  return false;
}

function fencedBlocks(body: string): Array<{ index: number; content: string }> {
  const blocks: Array<{ index: number; content: string }> = [];
  for (const match of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    blocks.push({ index: match.index, content: match[1].trim() });
  }
  return blocks;
}

function hasConcreteLogsInStableRow(body: string): boolean {
  for (const block of fencedBlocks(body)) {
    if (block.content.length >= 40) {
      return true;
    }
  }
  return /<details[^>]*>[\s\S]*?<summary[^>]*>[^<]*(?:logs?|console|network)[^<]*<\/summary>[\s\S]{40,}?<\/details>/i.test(
    body,
  );
}

function hasRowArtifact(
  rows: Map<EvidenceCategory, string[]>,
  category: EvidenceCategory,
): boolean {
  for (const row of rows.get(category) ?? []) {
    const concrete = withoutNotApplicableRows(row);
    if (category === "logs" && hasConcreteLogsInStableRow(concrete)) {
      return true;
    }
    if (
      extractUrls(concrete).some((candidate) =>
        isAllowedArtifactUrl(candidate.url, category),
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasConcreteEvidence(
  body: string,
  rows: Map<EvidenceCategory, string[]>,
  category: EvidenceCategory,
): boolean {
  if (hasRowArtifact(rows, category)) {
    return true;
  }
  if (category === "screenshot") {
    return hasContextualArtifact(
      body,
      category,
      /\b(?:before|after|desktop|mobile|screen(?:shot)?)\b/i,
    );
  }
  if (category === "video") {
    return hasContextualArtifact(
      body,
      category,
      /\b(?:mp4|recording|video|walkthrough)\b/i,
    );
  }
  if (category === "logs") {
    return hasContextualArtifact(
      body,
      category,
      /\b(?:backend|browser|client|console|frontend|logs?|network|stderr|stdout)\b/i,
    );
  }
  if (category === "trajectory") {
    return hasContextualArtifact(
      body,
      category,
      /\b(?:jsonl|model run|run viewer|scenario report|trajectory)\b/i,
    );
  }
  return hasContextualArtifact(
    body,
    category,
    /\b(?:artifact|database row|db row|generated file|memory|scheduled task|transaction|wallet)\b/i,
  );
}

export function assessEvidence(
  sources: GitHubTextSource[],
): EvidenceAssessment {
  const sourceIds = new Map<EvidenceCategory, Set<string>>();
  const categories: EvidenceCategory[] = [
    "screenshot",
    "video",
    "logs",
    "trajectory",
    "domain-artifact",
  ];

  for (const source of dedupeByNodeId(sources)) {
    if (source.author && isBotActor(source.author)) {
      continue;
    }
    const body = withoutNotApplicableRows(source.body);
    const rows = evidenceRows(source.body);
    for (const category of categories) {
      if (hasConcreteEvidence(body, rows, category)) {
        const ids = sourceIds.get(category) ?? new Set<string>();
        ids.add(source.id);
        sourceIds.set(category, ids);
      }
    }
  }

  const findings = [...sourceIds.entries()]
    .map(([category, ids]) => ({
      category,
      points: EVIDENCE_WEIGHTS[category],
      sourceIds: [...ids].sort(),
    }))
    .sort((left, right) => left.category.localeCompare(right.category));
  const points = Math.min(
    6,
    findings.reduce((total, finding) => total + finding.points, 0),
  );

  return {
    points,
    maxPoints: 6,
    categories: findings.map((finding) => finding.category),
    findings,
  };
}

function parseMarker(value: string):
  | {
      provider: string;
      model: string;
      client: string | null;
      skillRevision: string | null;
    }
  | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // error-policy:J3 an attribution marker with malformed JSON is explicitly invalid.
    return { error: "marker JSON is malformed" };
  }
  if (!isRecord(parsed)) {
    return { error: "marker payload must be an object" };
  }
  const expectedKeys = ["client", "model", "provider", "skill_revision"];
  if (Object.keys(parsed).sort().join(",") !== expectedKeys.sort().join(",")) {
    return {
      error:
        "marker must contain only provider, model, client, and skill_revision",
    };
  }
  const provider = parsed.provider;
  const model = parsed.model;
  if (
    typeof provider !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider) ||
    providerSlug(provider) !== provider ||
    ATTRIBUTION_PLACEHOLDER_PATTERN.test(provider) ||
    isGenericProviderIdentifier(provider)
  ) {
    return { error: "provider must be a concrete lowercase provider slug" };
  }
  if (
    typeof model !== "string" ||
    !/^[a-z0-9][a-z0-9._:/+-]{0,127}$/i.test(model) ||
    ATTRIBUTION_PLACEHOLDER_PATTERN.test(model) ||
    isGenericModelIdentifier(model)
  ) {
    return { error: "model must be an exact model identifier" };
  }
  const client = parsed.client;
  if (
    typeof client !== "string" ||
    client.length < 2 ||
    client.length > 128 ||
    ATTRIBUTION_PLACEHOLDER_PATTERN.test(client) ||
    /^n\/?a\b/i.test(client)
  ) {
    return { error: "client must name the concrete client used" };
  }
  const skillRevision = parsed.skill_revision;
  if (
    typeof skillRevision !== "string" ||
    skillRevision.length > 256 ||
    (!FULL_SKILL_REVISION_PATTERN.test(skillRevision) &&
      !/^n\/?a\s*[-:–—]\s*(?!<[^>]+>)(?!\[[^\]]+\])\S.{2,}$/i.test(
        skillRevision,
      ))
  ) {
    return {
      error:
        "skill_revision must be owner/repo@full-sha:path or N/A with a reason",
    };
  }
  return {
    provider,
    model,
    client: client.trim(),
    skillRevision: skillRevision.trim(),
  };
}

function exactIdentifier(provider: string, model: string): string {
  return model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
    ? model
    : `${provider}/${model}`;
}

function attributionLineValues(body: string, label: string): string[] {
  const expression = new RegExp(`^${label}\\s*:\\s*(.+?)\\s*$`, "i");
  return attributionDeclarationLines(body)
    .map((line) => line.match(expression)?.[1]?.trim())
    .filter((value): value is string => value !== undefined);
}

function markerFooterError(
  body: string,
  markerRecord: AttributionMarkerRecord,
  marker: {
    provider: string;
    model: string;
    client: string | null;
    skillRevision: string | null;
  },
): string | null {
  const lanePattern = /^(?:—|-)\s*\[([a-z0-9][a-z0-9-]{1,48})\]\s*$/i;
  const beforeMarker = attributionDeclarationLineRecords(
    body.slice(0, markerRecord.start),
  ).filter((record) => record.normalized.length > 0);
  const laneSignatures = beforeMarker.filter((record) =>
    lanePattern.test(record.normalized),
  );
  const terminalLane = beforeMarker.at(-1);
  if (
    laneSignatures.length !== 1 ||
    terminalLane === undefined ||
    !lanePattern.test(terminalLane.normalized) ||
    body.slice(terminalLane.end, markerRecord.start).trim().length !== 0
  ) {
    return "marker requires exactly one terminal lane signature";
  }
  if (body.slice(markerRecord.end).trim()) {
    return "marker must be the final source content";
  }
  const providerModelLines = attributionLineValues(body, "AI provider/model");
  const clientLines = attributionLineValues(body, "Client / agent tooling");
  const skillRevisionLines = attributionLineValues(
    body,
    "(?:Contribution skill revision|Skill revision)",
  );
  const statusLines = attributionLineValues(body, "Attribution status");
  if (
    providerModelLines.length !== 1 ||
    clientLines.length !== 1 ||
    skillRevisionLines.length !== 1 ||
    statusLines.length !== 1
  ) {
    return "marker requires exactly one complete visible attribution footer";
  }
  const providerModel = providerModelLines[0].match(/^([^/]+?)\s+\/\s+(.+)$/);
  if (!providerModel) {
    return "visible provider/model row is not canonical";
  }
  const visibleProvider = providerSlug(providerModel[1]);
  const visibleModel = providerModel[2].trim();
  if (
    marker.provider !== visibleProvider ||
    marker.model !== visibleModel ||
    marker.client !== clientLines[0] ||
    marker.skillRevision !== skillRevisionLines[0] ||
    statusLines[0].toLowerCase() !== "self-reported"
  ) {
    return "marker fields do not match the visible attribution footer";
  }
  return null;
}

export function assessModelAttribution(
  sources: GitHubTextSource[],
): AttributionAssessment {
  const declarations: ModelAttribution[] = [];
  const invalidMarkers: InvalidAttributionMarker[] = [];
  const eligibleSources = dedupeByNodeId(sources).filter(
    (source) =>
      source.author &&
      !isBotActor(source.author) &&
      (hasAttributionEligibilitySignal(source.body) ||
        hasMarkdownLine(source.body, HUMAN_ONLY_PATTERN) ||
        hasMarkdownLine(source.body, ISSUE_CLAIM_PATTERN) ||
        hasMarkdownLine(source.body, REVIEW_CLAIM_PATTERN)),
  );
  const validSourceIds = new Set<string>();
  const invalidSourceIds = new Set<string>();
  const humanOnlySourceIds = new Set<string>();

  for (const source of eligibleSources) {
    if (hasMarkdownLine(source.body, HUMAN_ONLY_PATTERN)) {
      humanOnlySourceIds.add(source.id);
      validSourceIds.add(source.id);
    }
    let markerIndex = 0;
    const markerIdentifiers = new Set<string>();
    const markerMatches = attributionMarkerRecords(source.body);
    if (markerMatches.length > 1) {
      invalidSourceIds.add(source.id);
      invalidMarkers.push({
        sourceId: source.id,
        sourceUrl: source.url,
        reason: "source must contain at most one attribution marker",
      });
    }
    const markerMatchesToParse =
      markerMatches.length === 1 ? markerMatches : [];
    for (const match of markerMatchesToParse) {
      const marker = parseMarker(match.payload);
      if ("error" in marker) {
        invalidSourceIds.add(source.id);
        invalidMarkers.push({
          sourceId: source.id,
          sourceUrl: source.url,
          reason: marker.error,
        });
        markerIndex += 1;
        continue;
      }
      const footerError = markerFooterError(source.body, match, marker);
      if (footerError) {
        invalidSourceIds.add(source.id);
        invalidMarkers.push({
          sourceId: source.id,
          sourceUrl: source.url,
          reason: footerError,
        });
        markerIndex += 1;
        continue;
      }
      const identifier = exactIdentifier(marker.provider, marker.model);
      validSourceIds.add(source.id);
      markerIdentifiers.add(identifier.toLowerCase());
      declarations.push({
        id: `${source.id}:machine-marker:${markerIndex}`,
        sourceId: source.id,
        sourceUrl: source.url,
        artifactId: source.artifactId,
        actor: source.author,
        provider: marker.provider,
        model: marker.model,
        identifier,
        client: marker.client,
        skillRevision: marker.skillRevision,
        format: "machine-marker",
        status: "self-reported",
      });
      markerIndex += 1;
    }

    let visibleIndex = 0;
    for (const line of attributionDeclarationLines(source.body)) {
      const declarationLine = line.match(
        /^\s*(?:[-*]\s*)?(?:AI\s+)?Model(?:s|\(s\))?(?:\s+used)?\s*:\s*(.+?)\s*$/i,
      );
      const canonicalLine = line.match(
        /^\s*(?:[-*]\s*)?AI\s+provider\s*\/\s*model\s*:\s*`?([a-z0-9][a-z0-9._-]{0,63})`?\s*\/\s*`?([a-z0-9][a-z0-9._:/-]{0,127})`?\s*$/i,
      );
      const visibleIdentifiers: Array<{ provider: string; model: string }> = [];
      if (declarationLine) {
        for (const match of declarationLine[1].matchAll(
          EXACT_MODEL_IDENTIFIER_PATTERN,
        )) {
          visibleIdentifiers.push({ provider: match[1], model: match[2] });
        }
      }
      if (canonicalLine) {
        visibleIdentifiers.push({
          provider: canonicalLine[1],
          model: canonicalLine[2],
        });
      }
      for (const declaration of visibleIdentifiers) {
        const normalizedProvider = providerSlug(declaration.provider);
        if (
          isGenericProviderIdentifier(normalizedProvider) ||
          isGenericModelIdentifier(declaration.model)
        ) {
          continue;
        }
        const identifier = `${declaration.provider}/${declaration.model}`;
        validSourceIds.add(source.id);
        if (markerIdentifiers.has(identifier.toLowerCase())) {
          continue;
        }
        declarations.push({
          id: `${source.id}:visible-declaration:${visibleIndex}`,
          sourceId: source.id,
          sourceUrl: source.url,
          artifactId: source.artifactId,
          actor: source.author,
          provider: declaration.provider,
          model: declaration.model,
          identifier,
          client: null,
          skillRevision: null,
          format: "visible-declaration",
          status: "self-reported",
        });
        visibleIndex += 1;
      }
    }
  }

  const eligibleSourceCount = eligibleSources.length;
  const validSourceCount = validSourceIds.size;
  const invalidSourceCount = invalidSourceIds.size;
  let status: AttributionCoverage["status"];
  if (
    eligibleSourceCount > 0 &&
    validSourceCount === eligibleSourceCount &&
    invalidSourceCount === 0
  ) {
    status = "complete";
  } else if (validSourceCount > 0) {
    status = "partial";
  } else if (invalidSourceCount > 0) {
    status = "invalid";
  } else {
    status = "missing";
  }

  return {
    declarations: dedupeByNodeId(declarations),
    invalidMarkers,
    coverage: {
      status,
      eligibleSourceCount,
      validSourceCount,
      missingSourceCount: eligibleSourceCount - validSourceCount,
      invalidSourceCount,
      humanOnlySourceCount: humanOnlySourceIds.size,
    },
  };
}

export function pullRequestTextSources(
  pullRequest: PullRequestRecord,
): GitHubTextSource[] {
  const body: GitHubTextSource = {
    id: `${pullRequest.id}:body`,
    artifactId: pullRequest.id,
    kind: "body",
    body: pullRequest.body,
    url: pullRequest.url,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.lastEditedAt ?? pullRequest.createdAt,
    author: pullRequest.author,
  };
  const reviewSources: GitHubTextSource[] = pullRequest.reviews.map(
    (review) => ({
      id: review.id,
      artifactId: pullRequest.id,
      kind: "review",
      body: review.body,
      url: review.url,
      createdAt: review.submittedAt ?? pullRequest.updatedAt,
      updatedAt: review.submittedAt ?? pullRequest.updatedAt,
      author: review.author,
    }),
  );
  return dedupeByNodeId([body, ...pullRequest.comments, ...reviewSources]);
}

export function issueTextSources(issue: IssueRecord): GitHubTextSource[] {
  return dedupeByNodeId([
    {
      id: `${issue.id}:body`,
      artifactId: issue.id,
      kind: "body",
      body: issue.body,
      url: issue.url,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      author: issue.author,
    },
    ...issue.comments,
  ]);
}

export function qualifiesResolvedIssue(issue: IssueRecord): boolean {
  if (!issue.closedAt) {
    return false;
  }
  if (issue.closedByPullRequests.some((pullRequest) => pullRequest.mergedAt)) {
    return true;
  }
  if (issue.stateReason === "NOT_PLANNED") {
    return false;
  }
  return issue.labels.some((label) =>
    CONFIRMATION_LABELS.has(normalizeLabel(label.name)),
  );
}

export function isSubstantiveReview(
  review: PullRequestReview,
  pullRequest: PullRequestRecord,
): boolean {
  if (!review.author || isBotActor(review.author) || !pullRequest.author) {
    return false;
  }
  if (
    review.author.id === pullRequest.author.id ||
    review.author.login.toLowerCase() === pullRequest.author.login.toLowerCase()
  ) {
    return false;
  }
  if (!review.submittedAt || !pullRequest.mergedAt) {
    return false;
  }
  if (parseIsoTime(review.submittedAt) > parseIsoTime(pullRequest.mergedAt)) {
    return false;
  }
  if (!["APPROVED", "CHANGES_REQUESTED"].includes(review.state)) {
    return false;
  }
  const substantiveBody = review.body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[#*_>`~[\]()!-]/g, "")
    .trim();
  return substantiveBody.length >= 20 || review.inlineCommentCount > 0;
}

function methodology(): LeaderboardMethodology {
  return {
    summary:
      "Version 2 rewards every merged outcome in the 30-day window and applies verification-intensive bonuses over a complete seven-day detail window.",
    scoringRules: [
      {
        id: "merged-pull-request",
        points: "10",
        cap: "once per immutable merged pull request ID",
        qualification:
          "Authored pull request merged during the rolling window.",
      },
      {
        id: "resolved-issue",
        points: "4",
        cap: "once per immutable issue ID",
        qualification:
          "Issue closed during the seven-day verification window and linked to a merged fix or carrying a trusted confirmed, validated, or triaged label.",
      },
      {
        id: "material-test-change",
        points: "4",
        cap: "once per qualifying merged pull request",
        qualification: `For pull requests in the seven-day verification window, recognized test files add at least ${MATERIAL_TEST_ADDITIONS} lines and change at least ${MATERIAL_TEST_CHURN} total lines.`,
      },
      {
        id: "evidence",
        points: "up to 6",
        cap: "one award per evidence category per merged pull request; six points total",
        qualification:
          "For pull requests in the seven-day verification window, concrete proof existed in the pull-request body or a comment at merge time and appears in stable evidence rows, category-labeled GitHub attachments, immutable repository artifacts, or supported transaction explorers; N/A rows do not qualify.",
      },
      {
        id: "substantive-review",
        points: "3",
        cap: "once per reviewer per merged pull request",
        qualification:
          "For pull requests in the seven-day verification window, a pre-merge APPROVED or CHANGES_REQUESTED review has substantive text or inline discussion.",
      },
    ],
    evidenceWeights: { ...EVIDENCE_WEIGHTS },
    materialTestThreshold: {
      minimumAdditions: MATERIAL_TEST_ADDITIONS,
      minimumTotalChurn: MATERIAL_TEST_CHURN,
      cap: "4 points once per merged pull request",
    },
    exclusions: [
      "GitHub Bot actors and bot-pattern logins",
      "self-reviews",
      "reviews submitted after merge",
      "pull-request bodies or comments created or edited after merge",
      "duplicate immutable GitHub node IDs",
      "repeated reviews by the same reviewer on the same pull request",
      "arbitrary external media links, bare checksums, and unstructured evidence claims",
      "closed issues that only carry GitHub's COMPLETED state reason",
    ],
    nonScoringActivity: [
      "raw comments",
      "commit count within the seven-day verification window",
      "lines added or deleted",
      "model disclosure",
    ],
    provenancePolicy:
      "Coverage is valid-source count over non-bot claims and text sources that declare AI or human-only provenance; ordinary human discussion is not eligible. Exact provider/model declarations, human-only declarations, and eliza-computer-attribution:v1 markers are self-reported provenance. Complete, partial, missing, and invalid states add no points.",
    collectionPolicy:
      "Every merged pull-request outcome is collected over 30 days with paginated, recursively split UTC time slices below GitHub Search's 1,000-result ceiling. Verification-intensive pull-request bonuses and resolved issues use a complete seven-day detail window. Open queues use complete repository connections. Counts publish both outcome and detail coverage, and immutable node IDs are deduplicated.",
  };
}

function newMutableEntry(actor: GitHubActor): MutableLeaderboardEntry {
  return {
    actor,
    score: 0,
    points: {
      mergedPullRequests: 0,
      resolvedIssues: 0,
      materialTestChanges: 0,
      evidence: 0,
      substantiveReviews: 0,
    },
    acceptedOutcomes: {
      mergedPullRequests: 0,
      resolvedIssues: 0,
      materialTestChanges: 0,
      evidenceCategories: 0,
      substantiveReviews: 0,
    },
    rawActivity: {
      comments: 0,
      reviews: 0,
      commits: 0,
      additions: 0,
      deletions: 0,
    },
    models: new Set<string>(),
  };
}

function actorEntry(
  entries: Map<string, MutableLeaderboardEntry>,
  actor: GitHubActor,
): MutableLeaderboardEntry {
  const key = actor.id;
  const current = entries.get(key);
  if (current) {
    return current;
  }
  const created = newMutableEntry(actor);
  entries.set(key, created);
  return created;
}

function addScore(
  entries: Map<string, MutableLeaderboardEntry>,
  ledger: ScoreEvent[],
  event: ScoreEvent,
): void {
  if (isBotActor(event.actor)) {
    return;
  }
  const entry = actorEntry(entries, event.actor);
  entry.score += event.points;
  if (event.category === "merged-pull-request") {
    entry.points.mergedPullRequests += event.points;
    entry.acceptedOutcomes.mergedPullRequests += 1;
  } else if (event.category === "resolved-issue") {
    entry.points.resolvedIssues += event.points;
    entry.acceptedOutcomes.resolvedIssues += 1;
  } else if (event.category === "material-test-change") {
    entry.points.materialTestChanges += event.points;
    entry.acceptedOutcomes.materialTestChanges += 1;
  } else if (event.category === "evidence") {
    entry.points.evidence += event.points;
    entry.acceptedOutcomes.evidenceCategories += 1;
  } else {
    entry.points.substantiveReviews += event.points;
    entry.acceptedOutcomes.substantiveReviews += 1;
  }
  ledger.push(event);
}

function recordTextActivity(
  entries: Map<string, MutableLeaderboardEntry>,
  sources: GitHubTextSource[],
): void {
  for (const source of dedupeByNodeId(sources)) {
    if (
      source.kind === "comment" &&
      source.author &&
      !isBotActor(source.author)
    ) {
      actorEntry(entries, source.author).rawActivity.comments += 1;
    }
  }
}

function evidenceSourcesAtMerge(
  pullRequest: PullRequestRecord,
  sources: GitHubTextSource[],
): GitHubTextSource[] {
  if (!pullRequest.mergedAt) {
    return [];
  }
  const mergedAt = parseIsoTime(pullRequest.mergedAt);
  return sources.filter(
    (source) =>
      source.kind !== "review" &&
      parseIsoTime(source.createdAt) <= mergedAt &&
      parseIsoTime(source.updatedAt) <= mergedAt,
  );
}

function modelStatus(assessment: AttributionAssessment): WorkItemModelStatus {
  const identifiers = uniqueSorted(
    assessment.declarations.map((declaration) => declaration.identifier),
  );
  const machineMarkerCount = assessment.declarations.filter(
    (declaration) => declaration.format === "machine-marker",
  ).length;
  return {
    status: assessment.coverage.status,
    identifiers,
    machineMarkerCount,
    invalidMarkerCount: assessment.invalidMarkers.length,
    eligibleSourceCount: assessment.coverage.eligibleSourceCount,
    validSourceCount: assessment.coverage.validSourceCount,
    missingSourceCount: assessment.coverage.missingSourceCount,
    invalidSourceCount: assessment.coverage.invalidSourceCount,
    humanOnlySourceCount: assessment.coverage.humanOnlySourceCount,
    provenance:
      assessment.coverage.validSourceCount > 0 ? "self-reported" : "none",
  };
}

function evidenceStatus(
  assessment: EvidenceAssessment,
): WorkItemEvidenceStatus {
  return {
    status:
      assessment.points === 6
        ? "complete"
        : assessment.points > 0
          ? "partial"
          : "missing",
    points: assessment.points,
    maxPoints: assessment.maxPoints,
    categories: assessment.categories,
  };
}

function latestClaimComment(
  comments: GitHubTextSource[],
  pattern: RegExp,
  referenceTime: string,
  excludedActor?: GitHubActor | null,
): GitHubTextSource | null {
  const now = parseIsoTime(referenceTime);
  const cutoff = now - CLAIM_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const matches = dedupeByNodeId(comments)
    .filter((comment) => {
      if (!comment.author || isBotActor(comment.author)) {
        return false;
      }
      if (
        excludedActor &&
        (comment.author.id === excludedActor.id ||
          comment.author.login.toLowerCase() ===
            excludedActor.login.toLowerCase())
      ) {
        return false;
      }
      const createdAt = parseIsoTime(comment.createdAt);
      return (
        createdAt >= cutoff &&
        createdAt <= now &&
        hasMarkdownLine(comment.body, pattern)
      );
    })
    .sort(
      (left, right) =>
        parseIsoTime(right.createdAt) - parseIsoTime(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  return matches[0] ?? null;
}

function issueClaim(
  issue: IssueRecord,
  referenceTime: string,
): WorkItemClaimStatus {
  const assignees = issue.assignees.filter((actor) => !isBotActor(actor));
  if (assignees.length > 0) {
    return {
      status: "claimed",
      source: "assignee",
      kind: "implementation",
      actors: assignees,
      claimedAt: null,
    };
  }
  const comment = latestClaimComment(
    issue.comments,
    ISSUE_CLAIM_PATTERN,
    referenceTime,
  );
  if (comment?.author) {
    return {
      status: "claimed",
      source: "claim-comment",
      kind: "implementation",
      actors: [comment.author],
      claimedAt: comment.createdAt,
    };
  }
  if (
    issue.labels.some((label) => CLAIM_LABELS.has(normalizeLabel(label.name)))
  ) {
    return {
      status: "claimed",
      source: "label",
      kind: "implementation",
      actors: [],
      claimedAt: null,
    };
  }
  return {
    status: "unclaimed",
    source: "none",
    kind: null,
    actors: [],
    claimedAt: null,
  };
}

function pullRequestClaim(
  pullRequest: PullRequestRecord,
  referenceTime: string,
): WorkItemClaimStatus {
  const assignees = pullRequest.assignees.filter(
    (actor) =>
      !isBotActor(actor) &&
      (!pullRequest.author ||
        (actor.id !== pullRequest.author.id &&
          actor.login.toLowerCase() !==
            pullRequest.author.login.toLowerCase())),
  );
  if (assignees.length > 0) {
    return {
      status: "claimed",
      source: "assignee",
      kind: "review",
      actors: assignees,
      claimedAt: null,
    };
  }
  const comment = latestClaimComment(
    pullRequest.comments,
    REVIEW_CLAIM_PATTERN,
    referenceTime,
    pullRequest.author,
  );
  if (comment?.author) {
    return {
      status: "claimed",
      source: "claim-comment",
      kind: "review",
      actors: [comment.author],
      claimedAt: comment.createdAt,
    };
  }
  if (
    pullRequest.labels.some((label) =>
      CLAIM_LABELS.has(normalizeLabel(label.name)),
    )
  ) {
    return {
      status: "claimed",
      source: "label",
      kind: "review",
      actors: [],
      claimedAt: null,
    };
  }
  return {
    status: "unclaimed",
    source: "none",
    kind: null,
    actors: [],
    claimedAt: null,
  };
}

function workItemPriority(labels: GitHubLabel[]): WorkItem["priority"] {
  const names = labels.map((label) => normalizeLabel(label.name));
  if (names.some((name) => URGENT_LABELS.has(name))) {
    return "urgent";
  }
  if (names.some((name) => HIGH_PRIORITY_LABELS.has(name))) {
    return "high";
  }
  if (names.some((name) => LOW_PRIORITY_LABELS.has(name))) {
    return "low";
  }
  return "normal";
}

function workItemActionability(
  labels: GitHubLabel[],
  isDraft: boolean,
): WorkItem["actionability"] {
  if (isDraft) {
    return "draft";
  }
  return labels.some((label) => BLOCKED_LABELS.has(normalizeLabel(label.name)))
    ? "blocked"
    : "actionable";
}

function issueWorkItem(
  issue: IssueRecord,
  referenceTime: string,
): {
  item: WorkItem;
  attribution: AttributionAssessment;
} {
  const sources = issueTextSources(issue);
  const evidence = assessEvidence(sources);
  const attribution = assessModelAttribution(sources);
  return {
    item: {
      id: issue.id,
      kind: "issue",
      number: issue.number,
      title: issue.title,
      url: issue.url,
      author: issue.author,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      labels: uniqueSorted(issue.labels.map((label) => label.name)),
      priority: workItemPriority(issue.labels),
      actionability: workItemActionability(issue.labels, false),
      isDraft: null,
      reviewDecision: null,
      commentCount: dedupeByNodeId(issue.comments).length,
      claim: issueClaim(issue, referenceTime),
      evidence: evidenceStatus(evidence),
      model: modelStatus(attribution),
    },
    attribution,
  };
}

function pullRequestWorkItem(
  pullRequest: PullRequestRecord,
  referenceTime: string,
): {
  item: WorkItem;
  attribution: AttributionAssessment;
} {
  const sources = pullRequestTextSources(pullRequest);
  const evidence = assessEvidence(sources);
  const attribution = assessModelAttribution(sources);
  return {
    item: {
      id: pullRequest.id,
      kind: "pull-request",
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      author: pullRequest.author,
      createdAt: pullRequest.createdAt,
      updatedAt: pullRequest.updatedAt,
      labels: uniqueSorted(pullRequest.labels.map((label) => label.name)),
      priority: workItemPriority(pullRequest.labels),
      actionability: workItemActionability(
        pullRequest.labels,
        pullRequest.isDraft,
      ),
      isDraft: pullRequest.isDraft,
      reviewDecision: pullRequest.reviewDecision,
      commentCount: dedupeByNodeId(pullRequest.comments).length,
      claim: pullRequestClaim(pullRequest, referenceTime),
      evidence: evidenceStatus(evidence),
      model: modelStatus(attribution),
    },
    attribution,
  };
}

function compareWorkItems(left: WorkItem, right: WorkItem): number {
  const actionabilityRank = {
    actionable: 0,
    blocked: 1,
    draft: 2,
  } as const;
  const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  return (
    actionabilityRank[left.actionability] -
      actionabilityRank[right.actionability] ||
    Number(left.claim.status === "claimed") -
      Number(right.claim.status === "claimed") ||
    priorityRank[left.priority] - priorityRank[right.priority] ||
    parseIsoTime(right.updatedAt) - parseIsoTime(left.updatedAt) ||
    right.number - left.number
  );
}

function latestSourceUpdate(input: LeaderboardInput): string {
  const timestamps = [
    input.sourceUpdatedAt,
    ...input.mergedPullRequestOutcomes.map((record) => record.updatedAt),
    ...input.mergedPullRequests.map((record) => record.updatedAt),
    ...input.resolvedIssues.map((record) => record.updatedAt),
    ...input.openIssues.map((record) => record.updatedAt),
    ...input.openPullRequests.map((record) => record.updatedAt),
  ];
  return timestamps.reduce((latest, current) =>
    parseIsoTime(current) > parseIsoTime(latest) ? current : latest,
  );
}

export function createLeaderboardSnapshot(
  input: LeaderboardInput,
): LeaderboardSnapshot {
  const mergedPullRequestOutcomes = dedupeByNodeId(
    input.mergedPullRequestOutcomes,
  );
  const mergedPullRequests = dedupeByNodeId(input.mergedPullRequests);
  const resolvedIssues = dedupeByNodeId(input.resolvedIssues).filter(
    qualifiesResolvedIssue,
  );
  const openIssues = dedupeByNodeId(input.openIssues);
  const openPullRequests = dedupeByNodeId(input.openPullRequests);
  const entries = new Map<string, MutableLeaderboardEntry>();
  const ledger: ScoreEvent[] = [];
  const outcomeIds = new Set(
    mergedPullRequestOutcomes.map((pullRequest) => pullRequest.id),
  );
  const verificationWindowFrom = parseIsoTime(input.verificationWindowFrom);
  const windowTo = parseIsoTime(input.windowTo);

  if (verificationWindowFrom >= windowTo) {
    throw new Error("verificationWindowFrom must precede windowTo");
  }
  for (const pullRequest of mergedPullRequests) {
    if (!outcomeIds.has(pullRequest.id)) {
      throw new Error(
        `Detailed pull request ${pullRequest.id} is missing from the complete outcome window`,
      );
    }
    if (
      !pullRequest.mergedAt ||
      parseIsoTime(pullRequest.mergedAt) < verificationWindowFrom ||
      parseIsoTime(pullRequest.mergedAt) > windowTo
    ) {
      throw new Error(
        `Detailed pull request ${pullRequest.id} falls outside the verification window`,
      );
    }
  }
  for (const issue of input.resolvedIssues) {
    if (
      !issue.closedAt ||
      parseIsoTime(issue.closedAt) < verificationWindowFrom ||
      parseIsoTime(issue.closedAt) > windowTo
    ) {
      throw new Error(
        `Detailed issue ${issue.id} falls outside the verification window`,
      );
    }
  }

  for (const pullRequest of mergedPullRequestOutcomes) {
    if (pullRequest.author && !isBotActor(pullRequest.author)) {
      const authorEntry = actorEntry(entries, pullRequest.author);
      authorEntry.rawActivity.additions += pullRequest.additions;
      authorEntry.rawActivity.deletions += pullRequest.deletions;
      addScore(entries, ledger, {
        id: `${pullRequest.id}:merged`,
        actor: pullRequest.author,
        category: "merged-pull-request",
        points: 10,
        source: {
          id: pullRequest.id,
          kind: "pull-request",
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
        },
        reason: "Pull request merged during the rolling window.",
      });
    }
  }

  for (const pullRequest of mergedPullRequests) {
    const sources = pullRequestTextSources(pullRequest);
    recordTextActivity(entries, sources);

    if (pullRequest.author && !isBotActor(pullRequest.author)) {
      const authorEntry = actorEntry(entries, pullRequest.author);
      authorEntry.rawActivity.commits += pullRequest.commitCount;
      if (hasMaterialTestChange(pullRequest.files)) {
        addScore(entries, ledger, {
          id: `${pullRequest.id}:tests`,
          actor: pullRequest.author,
          category: "material-test-change",
          points: 4,
          source: {
            id: pullRequest.id,
            kind: "pull-request",
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
          },
          reason: `Recognized test files met the ${MATERIAL_TEST_ADDITIONS}-addition and ${MATERIAL_TEST_CHURN}-churn threshold.`,
        });
      }

      const evidence = assessEvidence(
        evidenceSourcesAtMerge(pullRequest, sources),
      );
      for (const finding of evidence.findings) {
        addScore(entries, ledger, {
          id: `${pullRequest.id}:evidence:${finding.category}`,
          actor: pullRequest.author,
          category: "evidence",
          points: finding.points,
          source: {
            id: pullRequest.id,
            kind: "pull-request",
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
          },
          reason: `Concrete ${finding.category} evidence was attached or linked.`,
        });
      }
    }

    const awardedReviewers = new Set<string>();
    for (const review of dedupeByNodeId(pullRequest.reviews).sort(
      (left, right) => {
        if (left.submittedAt === right.submittedAt) {
          return left.id.localeCompare(right.id);
        }
        if (left.submittedAt === null) {
          return -1;
        }
        if (right.submittedAt === null) {
          return 1;
        }
        return left.submittedAt.localeCompare(right.submittedAt);
      },
    )) {
      if (review.author && !isBotActor(review.author)) {
        actorEntry(entries, review.author).rawActivity.reviews += 1;
      }
      if (
        !review.author ||
        awardedReviewers.has(review.author.id) ||
        !isSubstantiveReview(review, pullRequest)
      ) {
        continue;
      }
      awardedReviewers.add(review.author.id);
      addScore(entries, ledger, {
        id: `${pullRequest.id}:reviewer:${review.author.id}`,
        actor: review.author,
        category: "substantive-review",
        points: 3,
        source: {
          id: review.id,
          kind: "review",
          number: pullRequest.number,
          title: pullRequest.title,
          url: review.url,
        },
        reason:
          "First qualifying substantive, non-self review submitted before merge.",
      });
    }
  }

  for (const issue of resolvedIssues) {
    const sources = issueTextSources(issue);
    recordTextActivity(entries, sources);
    if (
      issue.author &&
      !isBotActor(issue.author) &&
      qualifiesResolvedIssue(issue)
    ) {
      addScore(entries, ledger, {
        id: `${issue.id}:resolved`,
        actor: issue.author,
        category: "resolved-issue",
        points: 4,
        source: {
          id: issue.id,
          kind: "issue",
          number: issue.number,
          title: issue.title,
          url: issue.url,
        },
        reason:
          "Issue was resolved or explicitly confirmed and closed during the rolling window.",
      });
    }
  }

  const issueQueue = openIssues.map((record) =>
    issueWorkItem(record, input.windowTo),
  );
  const pullRequestQueue = openPullRequests.map((record) =>
    pullRequestWorkItem(record, input.windowTo),
  );
  const overallAttribution = assessModelAttribution([
    ...mergedPullRequestOutcomes.map<GitHubTextSource>((pullRequest) => ({
      id: `${pullRequest.id}:body`,
      artifactId: pullRequest.id,
      kind: "body",
      body: pullRequest.body,
      url: pullRequest.url,
      createdAt: pullRequest.createdAt,
      updatedAt: pullRequest.updatedAt,
      author: pullRequest.author,
    })),
    ...mergedPullRequests.flatMap(pullRequestTextSources),
    ...resolvedIssues.flatMap(issueTextSources),
    ...openIssues.flatMap(issueTextSources),
    ...openPullRequests.flatMap(pullRequestTextSources),
  ]);
  const attributions = overallAttribution.declarations;
  for (const attribution of attributions) {
    if (attribution.actor && !isBotActor(attribution.actor)) {
      actorEntry(entries, attribution.actor).models.add(attribution.identifier);
    }
  }

  const leaders = [...entries.values()]
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.actor.login.localeCompare(right.actor.login, undefined, {
          sensitivity: "base",
        }),
    )
    .map<LeaderboardEntry>((entry, index) => ({
      rank: index + 1,
      actor: entry.actor,
      score: entry.score,
      points: { ...entry.points },
      acceptedOutcomes: { ...entry.acceptedOutcomes },
      rawActivity: { ...entry.rawActivity },
      reportedModels: uniqueSorted(entry.models),
    }));

  const snapshot: LeaderboardSnapshot = {
    schemaVersion: LEADERBOARD_SCHEMA_VERSION,
    repository: LEADERBOARD_REPOSITORY,
    ruleVersion: SCORE_RULE_VERSION,
    generatedAt: input.generatedAt,
    sourceUpdatedAt: latestSourceUpdate(input),
    stale: false,
    window: {
      days: SCORE_WINDOW_DAYS,
      from: input.windowFrom,
      to: input.windowTo,
    },
    methodology: methodology(),
    source: {
      ...input.source,
      counts: {
        mergedPullRequests: mergedPullRequestOutcomes.length,
        detailedMergedPullRequests: mergedPullRequests.length,
        closedIssues: input.closedIssueCount,
        detailedClosedIssues: input.resolvedIssues.length,
        resolvedIssues: resolvedIssues.length,
        openIssues: openIssues.length,
        openPullRequests: openPullRequests.length,
      },
      verificationWindow: {
        days: VERIFICATION_WINDOW_DAYS,
        from: input.verificationWindowFrom,
        to: input.windowTo,
      },
    },
    leaders,
    ledger: dedupeByNodeId(ledger).sort(
      (left, right) =>
        right.points - left.points ||
        left.source.number - right.source.number ||
        left.id.localeCompare(right.id),
    ),
    attributions,
    invalidAttributionMarkers: overallAttribution.invalidMarkers.sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        left.reason.localeCompare(right.reason),
    ),
    attributionCoverage: overallAttribution.coverage,
    workQueue: {
      issues: issueQueue.map((result) => result.item).sort(compareWorkItems),
      pullRequests: pullRequestQueue
        .map((result) => result.item)
        .sort(compareWorkItems),
    },
  };
  assertLeaderboardSnapshot(snapshot);
  return snapshot;
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function assertFiniteNumber(
  value: unknown,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
}

function assertNonNegativeInteger(
  value: unknown,
  path: string,
): asserts value is number {
  assertFiniteNumber(value, path);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

function assertPositiveInteger(
  value: unknown,
  path: string,
): asserts value is number {
  assertFiniteNumber(value, path);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
}

function assertIsoTimestamp(
  value: unknown,
  path: string,
): asserts value is string {
  assertString(value, path);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${path} must be a UTC ISO-8601 timestamp`);
  }
}

function assertWebUrl(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // error-policy:J3 a malformed public snapshot URL is explicitly rejected.
    throw new Error(`${path} must be a valid web URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${path} must be a valid web URL`);
  }
}

function assertEnum(
  value: unknown,
  allowed: readonly string[],
  path: string,
): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  }
}

function assertStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  const strings = value.map((item, index) => {
    assertString(item, `${path}[${index}]`);
    return item;
  });
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
  return strings;
}

function assertActorValue(value: unknown, path: string): void {
  const actor = assertObject(value, path);
  assertString(actor.id, `${path}.id`);
  assertString(actor.login, `${path}.login`);
  if (/\s/.test(actor.login)) {
    throw new Error(`${path}.login must be a GitHub login`);
  }
  assertWebUrl(actor.avatarUrl, `${path}.avatarUrl`);
  assertWebUrl(actor.url, `${path}.url`);
  assertEnum(
    actor.kind,
    ["Bot", "Mannequin", "Organization", "User", "Unknown"],
    `${path}.kind`,
  );
}

function assertNullableActor(value: unknown, path: string): void {
  if (value !== null) {
    assertActorValue(value, path);
  }
}

function assertMethodologyValue(value: unknown, path: string): void {
  const methodology = assertObject(value, path);
  assertString(methodology.summary, `${path}.summary`);
  if (
    !Array.isArray(methodology.scoringRules) ||
    methodology.scoringRules.length !== 5
  ) {
    throw new Error(`${path}.scoringRules must contain all five scoring rules`);
  }
  const expectedRuleIds: ScoreCategory[] = [
    "merged-pull-request",
    "resolved-issue",
    "material-test-change",
    "evidence",
    "substantive-review",
  ];
  const seenRuleIds = new Set<string>();
  methodology.scoringRules.forEach((ruleValue, index) => {
    const rulePath = `${path}.scoringRules[${index}]`;
    const rule = assertObject(ruleValue, rulePath);
    assertEnum(rule.id, expectedRuleIds, `${rulePath}.id`);
    if (seenRuleIds.has(rule.id)) {
      throw new Error(`${path}.scoringRules must not repeat rule IDs`);
    }
    seenRuleIds.add(rule.id);
    assertString(rule.points, `${rulePath}.points`);
    assertString(rule.cap, `${rulePath}.cap`);
    assertString(rule.qualification, `${rulePath}.qualification`);
  });
  if (seenRuleIds.size !== expectedRuleIds.length) {
    throw new Error(`${path}.scoringRules must publish every scoring rule`);
  }

  const evidenceWeights = assertObject(
    methodology.evidenceWeights,
    `${path}.evidenceWeights`,
  );
  const expectedEvidenceWeights: Record<EvidenceCategory, number> = {
    screenshot: 1,
    video: 2,
    logs: 1,
    trajectory: 1,
    "domain-artifact": 1,
  };
  for (const [category, expected] of Object.entries(expectedEvidenceWeights)) {
    assertFiniteNumber(
      evidenceWeights[category],
      `${path}.evidenceWeights.${category}`,
    );
    if (evidenceWeights[category] !== expected) {
      throw new Error(
        `${path}.evidenceWeights.${category} must be ${expected}`,
      );
    }
  }

  const testThreshold = assertObject(
    methodology.materialTestThreshold,
    `${path}.materialTestThreshold`,
  );
  assertNonNegativeInteger(
    testThreshold.minimumAdditions,
    `${path}.materialTestThreshold.minimumAdditions`,
  );
  assertNonNegativeInteger(
    testThreshold.minimumTotalChurn,
    `${path}.materialTestThreshold.minimumTotalChurn`,
  );
  if (testThreshold.minimumAdditions !== MATERIAL_TEST_ADDITIONS) {
    throw new Error(
      `${path}.materialTestThreshold.minimumAdditions must be ${MATERIAL_TEST_ADDITIONS}`,
    );
  }
  if (testThreshold.minimumTotalChurn !== MATERIAL_TEST_CHURN) {
    throw new Error(
      `${path}.materialTestThreshold.minimumTotalChurn must be ${MATERIAL_TEST_CHURN}`,
    );
  }
  assertString(testThreshold.cap, `${path}.materialTestThreshold.cap`);
  assertStringArray(methodology.exclusions, `${path}.exclusions`);
  assertStringArray(
    methodology.nonScoringActivity,
    `${path}.nonScoringActivity`,
  );
  assertString(methodology.provenancePolicy, `${path}.provenancePolicy`);
  assertString(methodology.collectionPolicy, `${path}.collectionPolicy`);
}

function assertSourceValue(value: unknown, path: string): void {
  const source = assertObject(value, path);
  if (source.provider !== "github-graphql") {
    throw new Error(`${path}.provider must be github-graphql`);
  }
  assertIsoTimestamp(source.fetchedAt, `${path}.fetchedAt`);
  assertIsoTimestamp(source.cutoffAt, `${path}.cutoffAt`);
  assertString(source.repositoryId, `${path}.repositoryId`);
  assertPositiveInteger(source.requestCount, `${path}.requestCount`);
  assertPositiveInteger(source.searchSliceCount, `${path}.searchSliceCount`);

  const rateLimit = assertObject(source.rateLimit, `${path}.rateLimit`);
  assertNonNegativeInteger(rateLimit.cost, `${path}.rateLimit.cost`);
  if (rateLimit.consumedDuringRun !== undefined) {
    assertNonNegativeInteger(
      rateLimit.consumedDuringRun,
      `${path}.rateLimit.consumedDuringRun`,
    );
  }
  assertPositiveInteger(rateLimit.limit, `${path}.rateLimit.limit`);
  assertNonNegativeInteger(rateLimit.remaining, `${path}.rateLimit.remaining`);
  if (
    typeof rateLimit.remaining === "number" &&
    typeof rateLimit.limit === "number" &&
    rateLimit.remaining > rateLimit.limit
  ) {
    throw new Error(`${path}.rateLimit.remaining cannot exceed its limit`);
  }
  assertIsoTimestamp(rateLimit.resetAt, `${path}.rateLimit.resetAt`);

  const counts = assertObject(source.counts, `${path}.counts`);
  assertNonNegativeInteger(
    counts.mergedPullRequests,
    `${path}.counts.mergedPullRequests`,
  );
  assertNonNegativeInteger(
    counts.detailedMergedPullRequests,
    `${path}.counts.detailedMergedPullRequests`,
  );
  assertNonNegativeInteger(counts.closedIssues, `${path}.counts.closedIssues`);
  assertNonNegativeInteger(
    counts.detailedClosedIssues,
    `${path}.counts.detailedClosedIssues`,
  );
  assertNonNegativeInteger(
    counts.resolvedIssues,
    `${path}.counts.resolvedIssues`,
  );
  assertNonNegativeInteger(counts.openIssues, `${path}.counts.openIssues`);
  assertNonNegativeInteger(
    counts.openPullRequests,
    `${path}.counts.openPullRequests`,
  );
  if (
    counts.detailedMergedPullRequests > counts.mergedPullRequests ||
    counts.detailedClosedIssues > counts.closedIssues ||
    counts.resolvedIssues > counts.detailedClosedIssues
  ) {
    throw new Error(`${path}.counts detail coverage exceeds its source count`);
  }

  const verificationWindow = assertObject(
    source.verificationWindow,
    `${path}.verificationWindow`,
  );
  assertFiniteNumber(
    verificationWindow.days,
    `${path}.verificationWindow.days`,
  );
  if (verificationWindow.days !== VERIFICATION_WINDOW_DAYS) {
    throw new Error(
      `${path}.verificationWindow.days must be ${VERIFICATION_WINDOW_DAYS}`,
    );
  }
  assertIsoTimestamp(
    verificationWindow.from,
    `${path}.verificationWindow.from`,
  );
  assertIsoTimestamp(verificationWindow.to, `${path}.verificationWindow.to`);
}

function assertNonNegativeNumber(value: unknown, path: string): void {
  assertFiniteNumber(value, path);
  if (value < 0) {
    throw new Error(`${path} must not be negative`);
  }
}

function assertLeaderValue(
  value: unknown,
  path: string,
  rank: number,
): asserts value is LeaderboardEntry {
  const entry = assertObject(value, path);
  assertPositiveInteger(entry.rank, `${path}.rank`);
  if (entry.rank !== rank) {
    throw new Error(`${path}.rank is not contiguous`);
  }
  assertActorValue(entry.actor, `${path}.actor`);
  assertPositiveInteger(entry.score, `${path}.score`);

  const points = assertObject(entry.points, `${path}.points`);
  const pointKeys = [
    "mergedPullRequests",
    "resolvedIssues",
    "materialTestChanges",
    "evidence",
    "substantiveReviews",
  ] as const;
  let scoreTotal = 0;
  for (const key of pointKeys) {
    assertNonNegativeInteger(points[key], `${path}.points.${key}`);
    scoreTotal += typeof points[key] === "number" ? points[key] : 0;
  }
  if (scoreTotal !== entry.score) {
    throw new Error(`${path}.score does not equal its point breakdown`);
  }

  const acceptedOutcomes = assertObject(
    entry.acceptedOutcomes,
    `${path}.acceptedOutcomes`,
  );
  for (const key of [
    "mergedPullRequests",
    "resolvedIssues",
    "materialTestChanges",
    "evidenceCategories",
    "substantiveReviews",
  ]) {
    assertNonNegativeInteger(
      acceptedOutcomes[key],
      `${path}.acceptedOutcomes.${key}`,
    );
  }

  const rawActivity = assertObject(entry.rawActivity, `${path}.rawActivity`);
  for (const key of [
    "comments",
    "reviews",
    "commits",
    "additions",
    "deletions",
  ]) {
    assertNonNegativeInteger(rawActivity[key], `${path}.rawActivity.${key}`);
  }
  const models = assertStringArray(
    entry.reportedModels,
    `${path}.reportedModels`,
  );
  models.forEach((identifier, index) => {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(
        identifier,
      )
    ) {
      throw new Error(
        `${path}.reportedModels[${index}] must be an exact provider/model identifier`,
      );
    }
  });
}

function assertCoverageCounts(
  value: Record<string, unknown>,
  path: string,
): { invalidSourceCount: number; validSourceCount: number } {
  const eligibleSourceCount = value.eligibleSourceCount;
  const validSourceCount = value.validSourceCount;
  const missingSourceCount = value.missingSourceCount;
  const invalidSourceCount = value.invalidSourceCount;
  const humanOnlySourceCount = value.humanOnlySourceCount;
  assertNonNegativeInteger(eligibleSourceCount, `${path}.eligibleSourceCount`);
  assertNonNegativeInteger(validSourceCount, `${path}.validSourceCount`);
  assertNonNegativeInteger(missingSourceCount, `${path}.missingSourceCount`);
  assertNonNegativeInteger(invalidSourceCount, `${path}.invalidSourceCount`);
  assertNonNegativeInteger(
    humanOnlySourceCount,
    `${path}.humanOnlySourceCount`,
  );
  assertEnum(
    value.status,
    ["complete", "partial", "missing", "invalid"],
    `${path}.status`,
  );
  if (
    validSourceCount > eligibleSourceCount ||
    invalidSourceCount > eligibleSourceCount ||
    humanOnlySourceCount > validSourceCount ||
    missingSourceCount !== eligibleSourceCount - validSourceCount
  ) {
    throw new Error(`${path} source counts are internally inconsistent`);
  }
  const expectedStatus: AttributionCoverage["status"] =
    eligibleSourceCount > 0 &&
    validSourceCount === eligibleSourceCount &&
    invalidSourceCount === 0
      ? "complete"
      : validSourceCount > 0
        ? "partial"
        : invalidSourceCount > 0
          ? "invalid"
          : "missing";
  if (value.status !== expectedStatus) {
    throw new Error(`${path}.status does not match its source coverage`);
  }
  return { invalidSourceCount, validSourceCount };
}

function assertWorkItemValue(
  value: unknown,
  path: string,
  expectedKind: WorkItem["kind"],
): asserts value is WorkItem {
  const item = assertObject(value, path);
  assertString(item.id, `${path}.id`);
  assertEnum(item.kind, ["issue", "pull-request"], `${path}.kind`);
  if (item.kind !== expectedKind) {
    throw new Error(`${path}.kind must be ${expectedKind}`);
  }
  assertPositiveInteger(item.number, `${path}.number`);
  assertString(item.title, `${path}.title`);
  assertWebUrl(item.url, `${path}.url`);
  assertNullableActor(item.author, `${path}.author`);
  assertIsoTimestamp(item.createdAt, `${path}.createdAt`);
  assertIsoTimestamp(item.updatedAt, `${path}.updatedAt`);
  assertStringArray(item.labels, `${path}.labels`);
  assertEnum(
    item.priority,
    ["urgent", "high", "normal", "low"],
    `${path}.priority`,
  );
  assertEnum(
    item.actionability,
    ["actionable", "blocked", "draft"],
    `${path}.actionability`,
  );
  if (expectedKind === "issue") {
    if (item.isDraft !== null || item.reviewDecision !== null) {
      throw new Error(
        `${path} issue draft and review-decision fields must be null`,
      );
    }
    if (item.actionability === "draft") {
      throw new Error(`${path} issue cannot have draft actionability`);
    }
  } else {
    if (typeof item.isDraft !== "boolean") {
      throw new Error(`${path}.isDraft must be a boolean for pull requests`);
    }
    if (item.reviewDecision !== null) {
      assertEnum(
        item.reviewDecision,
        ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"],
        `${path}.reviewDecision`,
      );
    }
    if (
      (item.isDraft === true && item.actionability !== "draft") ||
      (item.isDraft === false && item.actionability === "draft")
    ) {
      throw new Error(`${path}.actionability must match its draft state`);
    }
  }
  assertNonNegativeInteger(item.commentCount, `${path}.commentCount`);

  const claim = assertObject(item.claim, `${path}.claim`);
  assertEnum(claim.status, ["claimed", "unclaimed"], `${path}.claim.status`);
  assertEnum(
    claim.source,
    ["assignee", "label", "claim-comment", "none"],
    `${path}.claim.source`,
  );
  if (claim.kind !== null) {
    assertEnum(claim.kind, ["implementation", "review"], `${path}.claim.kind`);
  }
  if (!Array.isArray(claim.actors)) {
    throw new Error(`${path}.claim.actors must be an array`);
  }
  claim.actors.forEach((actor, index) => {
    assertActorValue(actor, `${path}.claim.actors[${index}]`);
  });
  if (claim.claimedAt !== null) {
    assertIsoTimestamp(claim.claimedAt, `${path}.claim.claimedAt`);
  }
  const expectedClaimKind =
    expectedKind === "issue" ? "implementation" : "review";
  if (
    (claim.status === "unclaimed" &&
      (claim.source !== "none" ||
        claim.kind !== null ||
        claim.actors.length !== 0 ||
        claim.claimedAt !== null)) ||
    (claim.status === "claimed" &&
      (claim.source === "none" || claim.kind !== expectedClaimKind)) ||
    (claim.source === "assignee" && claim.actors.length === 0) ||
    (claim.source === "claim-comment" &&
      (claim.actors.length !== 1 || claim.claimedAt === null)) ||
    (claim.source !== "claim-comment" && claim.claimedAt !== null)
  ) {
    throw new Error(`${path}.claim fields do not describe one valid claim`);
  }

  const evidence = assertObject(item.evidence, `${path}.evidence`);
  assertEnum(
    evidence.status,
    ["complete", "partial", "missing"],
    `${path}.evidence.status`,
  );
  assertNonNegativeInteger(evidence.points, `${path}.evidence.points`);
  if (evidence.maxPoints !== 6) {
    throw new Error(`${path}.evidence.maxPoints must be 6`);
  }
  if (typeof evidence.points === "number" && evidence.points > 6) {
    throw new Error(`${path}.evidence.points cannot exceed 6`);
  }
  const categories = assertStringArray(
    evidence.categories,
    `${path}.evidence.categories`,
  );
  categories.forEach((category, index) => {
    assertEnum(
      category,
      ["screenshot", "video", "logs", "trajectory", "domain-artifact"],
      `${path}.evidence.categories[${index}]`,
    );
  });
  if (
    (evidence.status === "missing" &&
      (evidence.points !== 0 || categories.length !== 0)) ||
    (evidence.status === "partial" &&
      (typeof evidence.points !== "number" ||
        evidence.points <= 0 ||
        evidence.points >= 6)) ||
    (evidence.status === "complete" && evidence.points !== 6)
  ) {
    throw new Error(
      `${path}.evidence status does not match its evidence points`,
    );
  }

  const model = assertObject(item.model, `${path}.model`);
  assertEnum(
    model.status,
    ["complete", "partial", "missing", "invalid"],
    `${path}.model.status`,
  );
  const identifiers = assertStringArray(
    model.identifiers,
    `${path}.model.identifiers`,
  );
  identifiers.forEach((identifier, index) => {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(
        identifier,
      )
    ) {
      throw new Error(
        `${path}.model.identifiers[${index}] must be an exact provider/model identifier`,
      );
    }
  });
  assertNonNegativeInteger(
    model.machineMarkerCount,
    `${path}.model.machineMarkerCount`,
  );
  assertNonNegativeInteger(
    model.invalidMarkerCount,
    `${path}.model.invalidMarkerCount`,
  );
  assertEnum(
    model.provenance,
    ["self-reported", "none"],
    `${path}.model.provenance`,
  );
  const coverageCounts = assertCoverageCounts(model, `${path}.model`);
  if (
    (model.machineMarkerCount > 0 && identifiers.length === 0) ||
    (identifiers.length > 0 && coverageCounts.validSourceCount === 0) ||
    model.invalidMarkerCount < coverageCounts.invalidSourceCount
  ) {
    throw new Error(`${path}.model declarations do not match source coverage`);
  }
  if (
    (coverageCounts.validSourceCount > 0 &&
      model.provenance !== "self-reported") ||
    (coverageCounts.validSourceCount === 0 && model.provenance !== "none")
  ) {
    throw new Error(
      `${path}.model provenance does not match its model identifiers`,
    );
  }
}

function assertLedgerValue(
  value: unknown,
  path: string,
): asserts value is ScoreEvent {
  const event = assertObject(value, path);
  assertString(event.id, `${path}.id`);
  assertActorValue(event.actor, `${path}.actor`);
  assertEnum(
    event.category,
    [
      "merged-pull-request",
      "resolved-issue",
      "material-test-change",
      "evidence",
      "substantive-review",
    ],
    `${path}.category`,
  );
  assertNonNegativeNumber(event.points, `${path}.points`);
  const validPoints =
    (event.category === "merged-pull-request" && event.points === 10) ||
    (event.category === "resolved-issue" && event.points === 4) ||
    (event.category === "material-test-change" && event.points === 4) ||
    (event.category === "substantive-review" && event.points === 3) ||
    (event.category === "evidence" &&
      (event.points === 1 || event.points === 2));
  if (!validPoints) {
    throw new Error(`${path}.points does not match its scoring category`);
  }
  assertString(event.reason, `${path}.reason`);
  const source = assertObject(event.source, `${path}.source`);
  assertString(source.id, `${path}.source.id`);
  assertEnum(
    source.kind,
    ["issue", "pull-request", "review"],
    `${path}.source.kind`,
  );
  assertPositiveInteger(source.number, `${path}.source.number`);
  assertString(source.title, `${path}.source.title`);
  assertWebUrl(source.url, `${path}.source.url`);
}

function assertAttributionValue(
  value: unknown,
  path: string,
): asserts value is ModelAttribution {
  const attribution = assertObject(value, path);
  assertString(attribution.id, `${path}.id`);
  assertString(attribution.sourceId, `${path}.sourceId`);
  assertWebUrl(attribution.sourceUrl, `${path}.sourceUrl`);
  assertString(attribution.artifactId, `${path}.artifactId`);
  assertNullableActor(attribution.actor, `${path}.actor`);
  assertString(attribution.provider, `${path}.provider`);
  assertString(attribution.model, `${path}.model`);
  assertString(attribution.identifier, `${path}.identifier`);
  if (
    attribution.identifier !==
    exactIdentifier(
      typeof attribution.provider === "string" ? attribution.provider : "",
      typeof attribution.model === "string" ? attribution.model : "",
    )
  ) {
    throw new Error(`${path}.identifier must match provider and model`);
  }
  if (attribution.client !== null) {
    assertString(attribution.client, `${path}.client`);
  }
  if (attribution.skillRevision !== null) {
    assertString(attribution.skillRevision, `${path}.skillRevision`);
  }
  assertEnum(
    attribution.format,
    ["machine-marker", "visible-declaration"],
    `${path}.format`,
  );
  if (attribution.status !== "self-reported") {
    throw new Error(`${path}.status must be self-reported`);
  }
}

export function assertLeaderboardSnapshot(
  value: unknown,
): asserts value is LeaderboardSnapshot {
  const snapshot = assertObject(value, "snapshot");
  if (snapshot.schemaVersion !== LEADERBOARD_SCHEMA_VERSION) {
    throw new Error(
      `snapshot.schemaVersion must be ${LEADERBOARD_SCHEMA_VERSION}`,
    );
  }
  if (snapshot.repository !== LEADERBOARD_REPOSITORY) {
    throw new Error(`snapshot.repository must be ${LEADERBOARD_REPOSITORY}`);
  }
  if (snapshot.ruleVersion !== SCORE_RULE_VERSION) {
    throw new Error(`snapshot.ruleVersion must be ${SCORE_RULE_VERSION}`);
  }
  if (snapshot.stale !== false) {
    throw new Error("A freshly generated snapshot must set stale=false");
  }
  assertIsoTimestamp(snapshot.generatedAt, "snapshot.generatedAt");
  assertIsoTimestamp(snapshot.sourceUpdatedAt, "snapshot.sourceUpdatedAt");

  const window = assertObject(snapshot.window, "snapshot.window");
  assertFiniteNumber(window.days, "snapshot.window.days");
  if (window.days !== SCORE_WINDOW_DAYS) {
    throw new Error(`snapshot.window.days must be ${SCORE_WINDOW_DAYS}`);
  }
  assertIsoTimestamp(window.from, "snapshot.window.from");
  assertIsoTimestamp(window.to, "snapshot.window.to");
  if (
    typeof window.from === "string" &&
    typeof window.to === "string" &&
    parseIsoTime(window.from) >= parseIsoTime(window.to)
  ) {
    throw new Error("snapshot.window.from must precede snapshot.window.to");
  }

  if (!Array.isArray(snapshot.leaders)) {
    throw new Error("snapshot.leaders must be an array");
  }
  const validatedLeaders = snapshot.leaders.map((valueEntry, index) => {
    assertLeaderValue(valueEntry, `snapshot.leaders[${index}]`, index + 1);
    return valueEntry;
  });
  if (
    new Set(validatedLeaders.map((entry) => entry.actor.id)).size !==
    validatedLeaders.length
  ) {
    throw new Error("snapshot.leaders must contain unique actors");
  }

  if (!Array.isArray(snapshot.ledger)) {
    throw new Error("snapshot.ledger must be an array");
  }
  const validatedLedger = snapshot.ledger.map((event, index) => {
    assertLedgerValue(event, `snapshot.ledger[${index}]`);
    return event;
  });
  if (
    new Set(validatedLedger.map((event) => event.id)).size !==
    validatedLedger.length
  ) {
    throw new Error("snapshot.ledger must contain unique score event IDs");
  }
  const leaderByActorId = new Map(
    validatedLeaders.map((entry) => [entry.actor.id, entry]),
  );
  for (const event of validatedLedger) {
    if (!leaderByActorId.has(event.actor.id)) {
      throw new Error(
        `snapshot.ledger event ${event.id} has no corresponding leader`,
      );
    }
  }
  for (const leader of validatedLeaders) {
    const events = validatedLedger.filter(
      (event) => event.actor.id === leader.actor.id,
    );
    const points = {
      mergedPullRequests: 0,
      resolvedIssues: 0,
      materialTestChanges: 0,
      evidence: 0,
      substantiveReviews: 0,
    };
    const outcomes = {
      mergedPullRequests: 0,
      resolvedIssues: 0,
      materialTestChanges: 0,
      evidenceCategories: 0,
      substantiveReviews: 0,
    };
    for (const event of events) {
      if (event.category === "merged-pull-request") {
        points.mergedPullRequests += event.points;
        outcomes.mergedPullRequests += 1;
      } else if (event.category === "resolved-issue") {
        points.resolvedIssues += event.points;
        outcomes.resolvedIssues += 1;
      } else if (event.category === "material-test-change") {
        points.materialTestChanges += event.points;
        outcomes.materialTestChanges += 1;
      } else if (event.category === "evidence") {
        points.evidence += event.points;
        outcomes.evidenceCategories += 1;
      } else {
        points.substantiveReviews += event.points;
        outcomes.substantiveReviews += 1;
      }
    }
    const ledgerScore = events.reduce(
      (total, event) => total + event.points,
      0,
    );
    if (
      ledgerScore !== leader.score ||
      points.mergedPullRequests !== leader.points.mergedPullRequests ||
      points.resolvedIssues !== leader.points.resolvedIssues ||
      points.materialTestChanges !== leader.points.materialTestChanges ||
      points.evidence !== leader.points.evidence ||
      points.substantiveReviews !== leader.points.substantiveReviews ||
      outcomes.mergedPullRequests !==
        leader.acceptedOutcomes.mergedPullRequests ||
      outcomes.resolvedIssues !== leader.acceptedOutcomes.resolvedIssues ||
      outcomes.materialTestChanges !==
        leader.acceptedOutcomes.materialTestChanges ||
      outcomes.evidenceCategories !==
        leader.acceptedOutcomes.evidenceCategories ||
      outcomes.substantiveReviews !== leader.acceptedOutcomes.substantiveReviews
    ) {
      throw new Error(
        `snapshot.leaders actor ${leader.actor.login} does not match the public ledger`,
      );
    }
  }
  if (!Array.isArray(snapshot.attributions)) {
    throw new Error("snapshot.attributions must be an array");
  }
  const validatedAttributions = snapshot.attributions.map(
    (attribution, index) => {
      assertAttributionValue(attribution, `snapshot.attributions[${index}]`);
      return attribution;
    },
  );
  if (
    new Set(validatedAttributions.map((attribution) => attribution.id)).size !==
    validatedAttributions.length
  ) {
    throw new Error("snapshot.attributions must contain unique IDs");
  }
  for (const leader of validatedLeaders) {
    const reportedModels = uniqueSorted(
      validatedAttributions
        .filter((attribution) => attribution.actor?.id === leader.actor.id)
        .map((attribution) => attribution.identifier),
    );
    if (
      reportedModels.length !== leader.reportedModels.length ||
      reportedModels.some(
        (identifier, index) => identifier !== leader.reportedModels[index],
      )
    ) {
      throw new Error(
        `snapshot.leaders actor ${leader.actor.login} has untraceable reported models`,
      );
    }
  }
  if (!Array.isArray(snapshot.invalidAttributionMarkers)) {
    throw new Error("snapshot.invalidAttributionMarkers must be an array");
  }
  snapshot.invalidAttributionMarkers.forEach((markerValue, index) => {
    const markerPath = `snapshot.invalidAttributionMarkers[${index}]`;
    const marker = assertObject(markerValue, markerPath);
    assertString(marker.sourceId, `${markerPath}.sourceId`);
    assertWebUrl(marker.sourceUrl, `${markerPath}.sourceUrl`);
    assertString(marker.reason, `${markerPath}.reason`);
  });
  const attributionCoverage = assertObject(
    snapshot.attributionCoverage,
    "snapshot.attributionCoverage",
  );
  const coverageCounts = assertCoverageCounts(
    attributionCoverage,
    "snapshot.attributionCoverage",
  );
  const attributedSourceIds = new Set(
    validatedAttributions.map((attribution) => attribution.sourceId),
  );
  const invalidSourceIds = new Set(
    snapshot.invalidAttributionMarkers.map((marker) =>
      isRecord(marker) && typeof marker.sourceId === "string"
        ? marker.sourceId
        : "",
    ),
  );
  if (
    attributedSourceIds.size > coverageCounts.validSourceCount ||
    invalidSourceIds.size !== coverageCounts.invalidSourceCount
  ) {
    throw new Error(
      "snapshot attribution records do not match attributionCoverage",
    );
  }

  const workQueue = assertObject(snapshot.workQueue, "snapshot.workQueue");
  if (
    !Array.isArray(workQueue.issues) ||
    !Array.isArray(workQueue.pullRequests)
  ) {
    throw new Error("snapshot.workQueue queues must be arrays");
  }
  const validatedIssues = workQueue.issues.map((item, index) => {
    assertWorkItemValue(item, `snapshot.workQueue.issues[${index}]`, "issue");
    return item;
  });
  const validatedPullRequests = workQueue.pullRequests.map((item, index) => {
    assertWorkItemValue(
      item,
      `snapshot.workQueue.pullRequests[${index}]`,
      "pull-request",
    );
    return item;
  });
  for (const [name, queue] of [
    ["issues", validatedIssues],
    ["pullRequests", validatedPullRequests],
  ] as const) {
    for (let index = 1; index < queue.length; index += 1) {
      if (compareWorkItems(queue[index - 1], queue[index]) > 0) {
        throw new Error(
          `snapshot.workQueue.${name} must prioritize actionable, unclaimed, labeled, recent work`,
        );
      }
    }
  }
  assertSourceValue(snapshot.source, "snapshot.source");
  const source = assertObject(snapshot.source, "snapshot.source");
  const counts = assertObject(source.counts, "snapshot.source.counts");
  const verificationWindow = assertObject(
    source.verificationWindow,
    "snapshot.source.verificationWindow",
  );
  if (
    verificationWindow.to !== window.to ||
    typeof verificationWindow.from !== "string" ||
    typeof verificationWindow.to !== "string" ||
    parseIsoTime(verificationWindow.to) -
      parseIsoTime(verificationWindow.from) !==
      VERIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000 ||
    parseIsoTime(verificationWindow.from) < parseIsoTime(window.from)
  ) {
    throw new Error(
      "snapshot.source.verificationWindow must be the exact trailing seven days of the rolling window",
    );
  }
  if (counts.openIssues !== workQueue.issues.length) {
    throw new Error(
      "snapshot.source.counts.openIssues must match the issue queue length",
    );
  }
  if (counts.openPullRequests !== workQueue.pullRequests.length) {
    throw new Error(
      "snapshot.source.counts.openPullRequests must match the pull request queue length",
    );
  }
  const mergedOutcomeEvents = validatedLedger.filter(
    (event) => event.category === "merged-pull-request",
  );
  const detailedPullRequestIds = new Set(
    validatedLedger
      .filter((event) =>
        ["material-test-change", "evidence", "substantive-review"].includes(
          event.category,
        ),
      )
      .map((event) =>
        event.category === "substantive-review"
          ? event.id.split(":reviewer:")[0]
          : event.source.id,
      ),
  );
  const resolvedIssueEvents = validatedLedger.filter(
    (event) => event.category === "resolved-issue",
  );
  const mergedPullRequestCount = counts.mergedPullRequests;
  const detailedMergedPullRequestCount = counts.detailedMergedPullRequests;
  const resolvedIssueCount = counts.resolvedIssues;
  assertNonNegativeInteger(
    mergedPullRequestCount,
    "snapshot.source.counts.mergedPullRequests",
  );
  assertNonNegativeInteger(
    detailedMergedPullRequestCount,
    "snapshot.source.counts.detailedMergedPullRequests",
  );
  assertNonNegativeInteger(
    resolvedIssueCount,
    "snapshot.source.counts.resolvedIssues",
  );
  if (
    mergedOutcomeEvents.length > mergedPullRequestCount ||
    detailedPullRequestIds.size > detailedMergedPullRequestCount ||
    resolvedIssueEvents.length !== resolvedIssueCount
  ) {
    throw new Error(
      "snapshot ledger exceeds the collection coverage published in source.counts",
    );
  }
  assertMethodologyValue(snapshot.methodology, "snapshot.methodology");
}
