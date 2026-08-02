/**
 * Collects the rolling contribution ledger and current work queues from the
 * authenticated GitHub GraphQL API. Time slicing, cursor pagination, runtime
 * validation, and atomic output keep API limits or partial data from ever
 * becoming a plausible-looking empty snapshot.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planReferencedArtifacts,
  verifyReferencedArtifacts,
} from "../../../scripts/check-pr-evidence.mjs";
import {
  assertPublishableLeaderboardSnapshot,
  createLeaderboardSnapshot,
  dedupeByNodeId,
  type EvidenceCategory,
  type GitHubActor,
  type GitHubActorKind,
  type GitHubLabel,
  type GitHubTextSource,
  type IssueRecord,
  isBotActor,
  LEADERBOARD_REPOSITORY,
  type LeaderboardSnapshot,
  type LeaderboardSourceMetadata,
  type MergedPullRequestOutcome,
  type PullRequestFile,
  type PullRequestRecord,
  type PullRequestReview,
  pullRequestTextSources,
  SCORE_WINDOW_DAYS,
  selectUniqueVerifiedEvidence,
  VERIFICATION_WINDOW_DAYS,
  type VerifiedEvidenceArtifact,
} from "../src/lib/leaderboard";

export const SEARCH_SAFE_RESULT_LIMIT = 950;
export const MINIMUM_SEARCH_SLICE_MS = 60_000;
export const GRAPHQL_PAGE_SIZE = 100;
export const DETAIL_BATCH_SIZE = 25;
export const REVIEW_DETAIL_BATCH_SIZE = 100;
export const MAX_TRANSIENT_ATTEMPTS = 3;
export const GRAPHQL_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_GENERATION_COST = 1_500;
export const MINIMUM_RATE_LIMIT_RESERVE = 100;
export const MINIMUM_STARTING_RATE_LIMIT = 900;
export const MAX_EVIDENCE_ARTIFACTS_PER_SNAPSHOT = 64;
export const MAX_EVIDENCE_SOURCES_PER_SNAPSHOT = 64;
export const MAX_EVIDENCE_ARTIFACTS_PER_SOURCE =
  MAX_EVIDENCE_ARTIFACTS_PER_SNAPSHOT;
export const EVIDENCE_VERIFICATION_CONCURRENCY = 4;
export const EVIDENCE_ARTIFACT_TIMEOUT_MS = 5_000;
export const EVIDENCE_CONTENT_DIGEST_LIMIT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public/data/leaderboard.json",
);

type JsonRecord = Record<string, unknown>;
type GraphqlVariables = Record<
  string,
  boolean | number | readonly string[] | string | null | undefined
>;
type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ConnectionPage<T> {
  totalCount: number;
  nodes: T[];
  pageInfo: PageInfo;
}

interface NestedPageState {
  totalCount: number;
  pageInfo: PageInfo;
}

type PendingPullRequestReview = Omit<
  PullRequestReview,
  "inlineCommentCount"
> & {
  commitId: string | null;
};
type PendingPullRequestRecord = Omit<PullRequestRecord, "reviews"> & {
  headRefOid: string;
  reviews: PendingPullRequestReview[];
};

interface ParsedPullRequest {
  record: PendingPullRequestRecord;
  state: string;
  pages: {
    comments: NestedPageState;
    reviews: NestedPageState;
    files: NestedPageState;
    closingIssues: NestedPageState;
  };
}

interface ParsedIssue {
  record: IssueRecord;
  state: string;
  pages: {
    comments: NestedPageState;
    closedByPullRequests: NestedPageState;
  };
}

interface NodeReference {
  id: string;
  kind: "Issue" | "PullRequest";
  outcome: MergedPullRequestOutcome | null;
  openVersion: string | null;
}

type ExpectedRecordState = "closed" | "merged" | "open";

class OpenSetChangedError extends Error {}

export interface RateLimitSnapshot {
  cost: number;
  consumedDuringRun: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface GraphqlExecutor {
  execute(document: string, variables?: GraphqlVariables): Promise<JsonRecord>;
  getRequestCount(): number;
  getRateLimit(): RateLimitSnapshot;
}

export interface GenerationProgress {
  phase:
    | "merged-pull-requests"
    | "resolved-issues"
    | "open-issues"
    | "open-pull-requests";
  completed: number;
  total: number;
}

export interface GenerateOptions {
  now?: Date;
  onProgress?: (progress: GenerationProgress) => void;
  evidenceFetch?: FetchLike;
  evidenceToken?: string;
  evidenceTimeoutMs?: number;
}

export interface GeneratorDependencies {
  getToken: () => Promise<string>;
  createClient: (token: string) => GraphqlExecutor;
  generate: (
    client: GraphqlExecutor,
    options?: GenerateOptions,
  ) => Promise<LeaderboardSnapshot>;
  write: (snapshot: LeaderboardSnapshot, outputPath: string) => Promise<void>;
}

const ACTOR_FRAGMENT = `
  fragment LeaderboardActor on Actor {
    __typename
    login
    avatarUrl
    url
    ... on User { id }
    ... on Bot { id }
    ... on Mannequin { id }
    ... on Organization { id }
  }
`;

const LABEL_FIELDS = `
  totalCount
  nodes {
    id
    name
    color
  }
`;

const ASSIGNEE_FIELDS = `
  totalCount
  nodes {
    __typename
    id
    login
    avatarUrl
    url
  }
`;

const COMMENT_FIELDS = `
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes {
    id
    body
    createdAt
    updatedAt
    authorAssociation
    url
    author { ...LeaderboardActor }
  }
`;

const REVIEW_FIELDS = `
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes {
    id
    body
    state
    submittedAt
    url
    commit { oid }
    author { ...LeaderboardActor }
  }
`;

const FILE_FIELDS = `
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes {
    path
    additions
    deletions
  }
`;

const PULL_REQUEST_FRAGMENT = `
  fragment LeaderboardPullRequest on PullRequest {
    id
    state
    number
    title
    url
    body
    createdAt
    updatedAt
    lastEditedAt
    mergedAt
    isDraft
    headRefOid
    reviewDecision
    reviewRequests(first: 1) { totalCount }
    author { ...LeaderboardActor }
    additions
    deletions
    changedFiles
    commits { totalCount }
    labels(first: 100) { ${LABEL_FIELDS} }
    assignees(first: 100) { ${ASSIGNEE_FIELDS} }
    comments(first: 100) { ${COMMENT_FIELDS} }
    reviews(first: 100) { ${REVIEW_FIELDS} }
    files(first: 100) { ${FILE_FIELDS} }
    closingIssuesReferences(first: 100) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
`;

const ISSUE_FRAGMENT = `
  fragment LeaderboardIssue on Issue {
    id
    state
    number
    title
    url
    body
    createdAt
    updatedAt
    closedAt
    stateReason
    author { ...LeaderboardActor }
    labels(first: 100) { ${LABEL_FIELDS} }
    assignees(first: 100) { ${ASSIGNEE_FIELDS} }
    comments(first: 100) { ${COMMENT_FIELDS} }
    closedByPullRequestsReferences(first: 100) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        url
        mergedAt
        body
        createdAt
        updatedAt
        author { ...LeaderboardActor }
      }
    }
  }
`;

const PREFLIGHT_QUERY = `
  query LeaderboardPreflight {
    repository(owner: "elizaOS", name: "eliza") { id updatedAt }
    rateLimit { cost limit remaining resetAt }
  }
`;

const SEARCH_REFERENCES_QUERY = `
  query LeaderboardSearchReferences(
    $searchQuery: String!
    $after: String
    $pageSize: Int!
  ) {
    search(
      type: ISSUE
      query: $searchQuery
      first: $pageSize
      after: $after
    ) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on Issue { id }
        ... on PullRequest {
          id
          state
          number
          title
          url
          body
          createdAt
          updatedAt
          mergedAt
          author { ...LeaderboardActor }
          additions
          deletions
        }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
  ${ACTOR_FRAGMENT}
`;

const PULL_REQUEST_DETAILS_QUERY = `
  query LeaderboardPullRequestDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on PullRequest { ...LeaderboardPullRequest }
    }
    rateLimit { cost limit remaining resetAt }
  }
  ${ACTOR_FRAGMENT}
  ${PULL_REQUEST_FRAGMENT}
`;

const ISSUE_DETAILS_QUERY = `
  query LeaderboardIssueDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Issue { ...LeaderboardIssue }
    }
    rateLimit { cost limit remaining resetAt }
  }
  ${ACTOR_FRAGMENT}
  ${ISSUE_FRAGMENT}
`;

const OPEN_PULL_REQUEST_REFERENCES_QUERY = `
  query LeaderboardOpenPullRequestReferences($after: String, $pageSize: Int!) {
    repository(owner: "elizaOS", name: "eliza") {
      id
      pullRequests(
        states: OPEN
        first: $pageSize
        after: $after
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id updatedAt headRefOid }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
`;

const OPEN_ISSUE_REFERENCES_QUERY = `
  query LeaderboardOpenIssueReferences($after: String, $pageSize: Int!) {
    repository(owner: "elizaOS", name: "eliza") {
      id
      issues(
        states: OPEN
        first: $pageSize
        after: $after
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id updatedAt }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
`;

const MORE_PULL_REQUEST_COMMENTS_QUERY = `
  query LeaderboardMorePullRequestComments($id: ID!, $after: String!) {
    node(id: $id) {
      ... on PullRequest {
        comments(first: 100, after: $after) { ${COMMENT_FIELDS} }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
  ${ACTOR_FRAGMENT}
`;

const MORE_ISSUE_COMMENTS_QUERY = `
  query LeaderboardMoreIssueComments($id: ID!, $after: String!) {
    node(id: $id) {
      ... on Issue {
        comments(first: 100, after: $after) { ${COMMENT_FIELDS} }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
  ${ACTOR_FRAGMENT}
`;

const MORE_REVIEWS_QUERY = `
  query LeaderboardMoreReviews($id: ID!, $after: String!) {
    node(id: $id) {
      ... on PullRequest {
        id
        headRefOid
        reviews(first: 100, after: $after) { ${REVIEW_FIELDS} }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
  ${ACTOR_FRAGMENT}
`;

const REVIEW_INLINE_COMMENTS_QUERY = `
  query LeaderboardReviewInlineComments($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on PullRequestReview {
        id
        comments(first: 100) { ${COMMENT_FIELDS} }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
  ${ACTOR_FRAGMENT}
`;

const MORE_REVIEW_INLINE_COMMENTS_QUERY = `
  query LeaderboardMoreReviewInlineComments($id: ID!, $after: String!) {
    node(id: $id) {
      ... on PullRequestReview {
        id
        comments(first: 100, after: $after) { ${COMMENT_FIELDS} }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
  ${ACTOR_FRAGMENT}
`;

const MORE_FILES_QUERY = `
  query LeaderboardMoreFiles($id: ID!, $after: String!) {
    node(id: $id) {
      ... on PullRequest {
        files(first: 100, after: $after) { ${FILE_FIELDS} }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
`;

const MORE_CLOSING_ISSUES_QUERY = `
  query LeaderboardMoreClosingIssues($id: ID!, $after: String!) {
    node(id: $id) {
      ... on PullRequest {
        closingIssuesReferences(first: 100, after: $after) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { id }
        }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
`;

const MORE_CLOSING_PULL_REQUESTS_QUERY = `
  query LeaderboardMoreClosingPullRequests($id: ID!, $after: String!) {
    node(id: $id) {
      ... on Issue {
        closedByPullRequestsReferences(first: 100, after: $after) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            number
            url
            mergedAt
            body
            createdAt
            updatedAt
            author { ...LeaderboardActor }
          }
        }
      }
    }
    rateLimit { cost limit remaining resetAt }
  }
  ${ACTOR_FRAGMENT}
`;

export const LEADERBOARD_QUERY_DOCUMENTS = {
  preflight: PREFLIGHT_QUERY,
  searchReferences: SEARCH_REFERENCES_QUERY,
  openIssueReferences: OPEN_ISSUE_REFERENCES_QUERY,
  openPullRequestReferences: OPEN_PULL_REQUEST_REFERENCES_QUERY,
  issueDetails: ISSUE_DETAILS_QUERY,
  pullRequestDetails: PULL_REQUEST_DETAILS_QUERY,
  reviewInlineComments: REVIEW_INLINE_COMMENTS_QUERY,
  morePullRequestComments: MORE_PULL_REQUEST_COMMENTS_QUERY,
  moreIssueComments: MORE_ISSUE_COMMENTS_QUERY,
  moreReviews: MORE_REVIEWS_QUERY,
  moreReviewInlineComments: MORE_REVIEW_INLINE_COMMENTS_QUERY,
  moreFiles: MORE_FILES_QUERY,
  moreClosingIssues: MORE_CLOSING_ISSUES_QUERY,
  moreClosingPullRequests: MORE_CLOSING_PULL_REQUESTS_QUERY,
} as const;

function asRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  return asString(value, path);
}

function asFullCommitSha(value: unknown, path: string): string {
  const commitId = asString(value, path);
  if (!/^[a-f0-9]{40}$/i.test(commitId)) {
    throw new Error(`${path} must be a full commit SHA`);
  }
  return commitId.toLowerCase();
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function child(record: JsonRecord, key: string, path: string): JsonRecord {
  return asRecord(record[key], `${path}.${key}`);
}

function parsePageInfo(value: unknown, path: string): PageInfo {
  const page = asRecord(value, path);
  return {
    hasNextPage: asBoolean(page.hasNextPage, `${path}.hasNextPage`),
    endCursor: asNullableString(page.endCursor, `${path}.endCursor`),
  };
}

function actorKind(value: string): GitHubActorKind {
  if (
    value === "Bot" ||
    value === "Mannequin" ||
    value === "Organization" ||
    value === "User"
  ) {
    return value;
  }
  return "Unknown";
}

function parseActor(value: unknown, path: string): GitHubActor | null {
  if (value === null) {
    return null;
  }
  const actor = asRecord(value, path);
  return {
    id: asString(actor.id, `${path}.id`),
    login: asString(actor.login, `${path}.login`),
    avatarUrl: asString(actor.avatarUrl, `${path}.avatarUrl`),
    url: asString(actor.url, `${path}.url`),
    kind: actorKind(asString(actor.__typename, `${path}.__typename`)),
  };
}

function parseLabels(value: unknown, path: string): GitHubLabel[] {
  const connection = asRecord(value, path);
  const nodes = asArray(connection.nodes, `${path}.nodes`).map(
    (nodeValue, index) => {
      const node = asRecord(nodeValue, `${path}.nodes[${index}]`);
      return {
        id: asString(node.id, `${path}.nodes[${index}].id`),
        name: asString(node.name, `${path}.nodes[${index}].name`),
        color: asString(node.color, `${path}.nodes[${index}].color`),
      };
    },
  );
  const totalCount = asNumber(connection.totalCount, `${path}.totalCount`);
  if (nodes.length !== totalCount) {
    throw new Error(
      `${path} has ${totalCount} labels; the 100-label collector cannot return a complete record`,
    );
  }
  return dedupeByNodeId(nodes);
}

function parseAssignees(value: unknown, path: string): GitHubActor[] {
  const connection = asRecord(value, path);
  const nodes = asArray(connection.nodes, `${path}.nodes`).map(
    (nodeValue, index) => {
      const actor = parseActor(nodeValue, `${path}.nodes[${index}]`);
      if (!actor) {
        throw new Error(`${path}.nodes[${index}] cannot be null`);
      }
      return actor;
    },
  );
  const totalCount = asNumber(connection.totalCount, `${path}.totalCount`);
  if (nodes.length !== totalCount) {
    throw new Error(
      `${path} has ${totalCount} assignees; the 100-assignee collector cannot return a complete record`,
    );
  }
  return dedupeByNodeId(nodes);
}

function parseComments(
  value: unknown,
  path: string,
  artifactId: string,
): ConnectionPage<GitHubTextSource> {
  const connection = asRecord(value, path);
  return {
    totalCount: asNumber(connection.totalCount, `${path}.totalCount`),
    pageInfo: parsePageInfo(connection.pageInfo, `${path}.pageInfo`),
    nodes: asArray(connection.nodes, `${path}.nodes`).map(
      (nodeValue, index) => {
        const nodePath = `${path}.nodes[${index}]`;
        const node = asRecord(nodeValue, nodePath);
        return {
          id: asString(node.id, `${nodePath}.id`),
          artifactId,
          kind: "comment",
          body: asString(node.body, `${nodePath}.body`),
          url: asString(node.url, `${nodePath}.url`),
          createdAt: asString(node.createdAt, `${nodePath}.createdAt`),
          updatedAt: asString(node.updatedAt, `${nodePath}.updatedAt`),
          author: parseActor(node.author, `${nodePath}.author`),
          authorAssociation: asString(
            node.authorAssociation,
            `${nodePath}.authorAssociation`,
          ),
        };
      },
    ),
  };
}

function parseReviews(
  value: unknown,
  path: string,
): ConnectionPage<PendingPullRequestReview> {
  const connection = asRecord(value, path);
  return {
    totalCount: asNumber(connection.totalCount, `${path}.totalCount`),
    pageInfo: parsePageInfo(connection.pageInfo, `${path}.pageInfo`),
    nodes: asArray(connection.nodes, `${path}.nodes`).map(
      (nodeValue, index) => {
        const nodePath = `${path}.nodes[${index}]`;
        const node = asRecord(nodeValue, nodePath);
        return {
          id: asString(node.id, `${nodePath}.id`),
          body: asString(node.body, `${nodePath}.body`),
          state: asString(node.state, `${nodePath}.state`),
          submittedAt: asNullableString(
            node.submittedAt,
            `${nodePath}.submittedAt`,
          ),
          url: asString(node.url, `${nodePath}.url`),
          commitId:
            node.commit === null
              ? null
              : asFullCommitSha(
                  child(node, "commit", nodePath).oid,
                  `${nodePath}.commit.oid`,
                ),
          author: parseActor(node.author, `${nodePath}.author`),
        };
      },
    ),
  };
}

function parseFiles(
  value: unknown,
  path: string,
): ConnectionPage<PullRequestFile> {
  const connection = asRecord(value, path);
  return {
    totalCount: asNumber(connection.totalCount, `${path}.totalCount`),
    pageInfo: parsePageInfo(connection.pageInfo, `${path}.pageInfo`),
    nodes: asArray(connection.nodes, `${path}.nodes`).map(
      (nodeValue, index) => {
        const nodePath = `${path}.nodes[${index}]`;
        const node = asRecord(nodeValue, nodePath);
        return {
          path: asString(node.path, `${nodePath}.path`),
          additions: asNumber(node.additions, `${nodePath}.additions`),
          deletions: asNumber(node.deletions, `${nodePath}.deletions`),
        };
      },
    ),
  };
}

function parseClosingIssueIds(
  value: unknown,
  path: string,
): ConnectionPage<{ id: string }> {
  const connection = asRecord(value, path);
  return {
    totalCount: asNumber(connection.totalCount, `${path}.totalCount`),
    pageInfo: parsePageInfo(connection.pageInfo, `${path}.pageInfo`),
    nodes: asArray(connection.nodes, `${path}.nodes`).map(
      (nodeValue, index) => {
        const nodePath = `${path}.nodes[${index}]`;
        const node = asRecord(nodeValue, nodePath);
        return { id: asString(node.id, `${nodePath}.id`) };
      },
    ),
  };
}

function parseClosingPullRequests(
  value: unknown,
  path: string,
): ConnectionPage<IssueRecord["closedByPullRequests"][number]> {
  const connection = asRecord(value, path);
  return {
    totalCount: asNumber(connection.totalCount, `${path}.totalCount`),
    pageInfo: parsePageInfo(connection.pageInfo, `${path}.pageInfo`),
    nodes: asArray(connection.nodes, `${path}.nodes`).map(
      (nodeValue, index) => {
        const nodePath = `${path}.nodes[${index}]`;
        const node = asRecord(nodeValue, nodePath);
        return {
          id: asString(node.id, `${nodePath}.id`),
          number: asNumber(node.number, `${nodePath}.number`),
          url: asString(node.url, `${nodePath}.url`),
          mergedAt: asNullableString(node.mergedAt, `${nodePath}.mergedAt`),
          body: asString(node.body, `${nodePath}.body`),
          createdAt: asString(node.createdAt, `${nodePath}.createdAt`),
          updatedAt: asString(node.updatedAt, `${nodePath}.updatedAt`),
          author: parseActor(node.author, `${nodePath}.author`),
        };
      },
    ),
  };
}

function pageState<T>(page: ConnectionPage<T>): NestedPageState {
  return { totalCount: page.totalCount, pageInfo: page.pageInfo };
}

function parsePullRequest(value: unknown, path: string): ParsedPullRequest {
  const node = asRecord(value, path);
  const id = asString(node.id, `${path}.id`);
  const comments = parseComments(node.comments, `${path}.comments`, id);
  const reviews = parseReviews(node.reviews, `${path}.reviews`);
  const files = parseFiles(node.files, `${path}.files`);
  const closingIssues = parseClosingIssueIds(
    node.closingIssuesReferences,
    `${path}.closingIssuesReferences`,
  );
  return {
    state: asString(node.state, `${path}.state`),
    record: {
      id,
      number: asNumber(node.number, `${path}.number`),
      title: asString(node.title, `${path}.title`),
      url: asString(node.url, `${path}.url`),
      body: asString(node.body, `${path}.body`),
      createdAt: asString(node.createdAt, `${path}.createdAt`),
      updatedAt: asString(node.updatedAt, `${path}.updatedAt`),
      lastEditedAt: asNullableString(node.lastEditedAt, `${path}.lastEditedAt`),
      mergedAt: asNullableString(node.mergedAt, `${path}.mergedAt`),
      isDraft: asBoolean(node.isDraft, `${path}.isDraft`),
      headRefOid: asFullCommitSha(node.headRefOid, `${path}.headRefOid`),
      reviewDecision: asNullableString(
        node.reviewDecision,
        `${path}.reviewDecision`,
      ),
      activeReviewRequestCount: asNumber(
        child(node, "reviewRequests", path).totalCount,
        `${path}.reviewRequests.totalCount`,
      ),
      author: parseActor(node.author, `${path}.author`),
      assignees: parseAssignees(node.assignees, `${path}.assignees`),
      labels: parseLabels(node.labels, `${path}.labels`),
      files: files.nodes,
      comments: comments.nodes,
      reviews: reviews.nodes,
      closingIssueIds: closingIssues.nodes.map((issue) => issue.id),
      additions: asNumber(node.additions, `${path}.additions`),
      deletions: asNumber(node.deletions, `${path}.deletions`),
      changedFiles: asNumber(node.changedFiles, `${path}.changedFiles`),
      commitCount: asNumber(
        child(node, "commits", path).totalCount,
        `${path}.commits.totalCount`,
      ),
    },
    pages: {
      comments: pageState(comments),
      reviews: pageState(reviews),
      files: pageState(files),
      closingIssues: pageState(closingIssues),
    },
  };
}

function parseIssue(value: unknown, path: string): ParsedIssue {
  const node = asRecord(value, path);
  const id = asString(node.id, `${path}.id`);
  const comments = parseComments(node.comments, `${path}.comments`, id);
  const closedByPullRequests = parseClosingPullRequests(
    node.closedByPullRequestsReferences,
    `${path}.closedByPullRequestsReferences`,
  );
  return {
    state: asString(node.state, `${path}.state`),
    record: {
      id,
      number: asNumber(node.number, `${path}.number`),
      title: asString(node.title, `${path}.title`),
      url: asString(node.url, `${path}.url`),
      body: asString(node.body, `${path}.body`),
      createdAt: asString(node.createdAt, `${path}.createdAt`),
      updatedAt: asString(node.updatedAt, `${path}.updatedAt`),
      closedAt: asNullableString(node.closedAt, `${path}.closedAt`),
      stateReason: asNullableString(node.stateReason, `${path}.stateReason`),
      author: parseActor(node.author, `${path}.author`),
      assignees: parseAssignees(node.assignees, `${path}.assignees`),
      labels: parseLabels(node.labels, `${path}.labels`),
      comments: comments.nodes,
      closedByPullRequests: closedByPullRequests.nodes,
    },
    pages: {
      comments: pageState(comments),
      closedByPullRequests: pageState(closedByPullRequests),
    },
  };
}

function parseSearchPage<T>(
  data: JsonRecord,
  parser: (value: unknown, path: string) => T,
): ConnectionPage<T> {
  const search = child(data, "search", "data");
  return {
    totalCount: asNumber(search.issueCount, "data.search.issueCount"),
    pageInfo: parsePageInfo(search.pageInfo, "data.search.pageInfo"),
    nodes: asArray(search.nodes, "data.search.nodes").map((node, index) =>
      parser(node, `data.search.nodes[${index}]`),
    ),
  };
}

function parseRepositoryConnection<T>(
  data: JsonRecord,
  field: "issues" | "pullRequests",
  parser: (value: unknown, path: string) => T,
): { repositoryId: string; page: ConnectionPage<T> } {
  const repository = child(data, "repository", "data");
  const connection = child(repository, field, "data.repository");
  return {
    repositoryId: asString(repository.id, "data.repository.id"),
    page: {
      totalCount: asNumber(
        connection.totalCount,
        `data.repository.${field}.totalCount`,
      ),
      pageInfo: parsePageInfo(
        connection.pageInfo,
        `data.repository.${field}.pageInfo`,
      ),
      nodes: asArray(connection.nodes, `data.repository.${field}.nodes`).map(
        (node, index) =>
          parser(node, `data.repository.${field}.nodes[${index}]`),
      ),
    },
  };
}

function sanitizeGraphqlError(value: unknown): string {
  if (typeof value === "string") {
    return value.slice(0, 500);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const message = (value as JsonRecord).message;
    if (typeof message === "string") {
      return message.slice(0, 500);
    }
  }
  return "Unknown GraphQL error";
}

function parseRateLimit(
  value: unknown,
): Omit<RateLimitSnapshot, "consumedDuringRun"> {
  const rateLimit = asRecord(value, "data.rateLimit");
  return {
    cost: asNumber(rateLimit.cost, "data.rateLimit.cost"),
    limit: asNumber(rateLimit.limit, "data.rateLimit.limit"),
    remaining: asNumber(rateLimit.remaining, "data.rateLimit.remaining"),
    resetAt: asString(rateLimit.resetAt, "data.rateLimit.resetAt"),
  };
}

export interface GitHubGraphqlClientOptions {
  requestTimeoutMs?: number;
  maxGenerationCost?: number;
  minimumRateLimitReserve?: number;
  retryBaseDelayMs?: number;
}

function isTransientNetworkError(value: unknown): boolean {
  if (value instanceof TypeError) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const error = value as { code?: unknown; name?: unknown };
  return (
    error.name === "AbortError" ||
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(typeof error.code === "string" ? error.code : "")
  );
}

function isJsonContentType(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || mediaType?.endsWith("+json") === true
  );
}

async function retryDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

export class GitHubGraphqlClient implements GraphqlExecutor {
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;
  readonly #maxGenerationCost: number;
  readonly #minimumRateLimitReserve: number;
  readonly #retryBaseDelayMs: number;
  #requestCount = 0;
  #rateLimit: RateLimitSnapshot | null = null;
  #consumedCost = 0;
  #startingRemaining: number | null = null;

  #effectiveMaxGenerationCost(): number {
    if (!this.#rateLimit) {
      return this.#maxGenerationCost;
    }
    return Math.min(
      this.#maxGenerationCost,
      Math.max(0, this.#rateLimit.limit - this.#minimumRateLimitReserve),
    );
  }

  constructor(
    token: string,
    fetcher: FetchLike = globalThis.fetch,
    options: GitHubGraphqlClientOptions = {},
  ) {
    if (!token.trim()) {
      throw new Error("GitHub token cannot be empty");
    }
    const requestTimeoutMs =
      options.requestTimeoutMs ?? GRAPHQL_REQUEST_TIMEOUT_MS;
    const maxGenerationCost = options.maxGenerationCost ?? MAX_GENERATION_COST;
    const minimumRateLimitReserve =
      options.minimumRateLimitReserve ?? MINIMUM_RATE_LIMIT_RESERVE;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    for (const [name, value] of [
      ["requestTimeoutMs", requestTimeoutMs],
      ["maxGenerationCost", maxGenerationCost],
      ["minimumRateLimitReserve", minimumRateLimitReserve],
      ["retryBaseDelayMs", retryBaseDelayMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative finite number`);
      }
    }
    this.#token = token.trim();
    this.#fetch = fetcher;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxGenerationCost = maxGenerationCost;
    this.#minimumRateLimitReserve = minimumRateLimitReserve;
    this.#retryBaseDelayMs = retryBaseDelayMs;
  }

  async execute(
    document: string,
    variables: GraphqlVariables = {},
  ): Promise<JsonRecord> {
    let response: Response | null = null;
    let payload: unknown;
    let parsedResponse = false;
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
      const effectiveMaxGenerationCost = this.#effectiveMaxGenerationCost();
      if (
        this.#consumedCost >= effectiveMaxGenerationCost ||
        (this.#rateLimit &&
          this.#rateLimit.remaining <= this.#minimumRateLimitReserve)
      ) {
        throw new Error(
          `GitHub GraphQL safety budget reached before request ${this.#requestCount + 1} (${this.#consumedCost}/${effectiveMaxGenerationCost} points consumed, ${this.#rateLimit?.remaining ?? "unknown"} remaining)`,
        );
      }
      this.#requestCount += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, this.#requestTimeoutMs);
      let responseBody = "";
      try {
        response = await this.#fetch("https://api.github.com/graphql", {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.#token}`,
            "Content-Type": "application/json",
            "User-Agent": "eliza-computer-leaderboard",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ query: document, variables }),
          signal: controller.signal,
        });
        responseBody = await response.text();
      } catch (cause) {
        // error-policy:J2 Retry only transient transport failures; the final
        // attempt rethrows with the request boundary and original cause.
        const timedOut = controller.signal.aborted;
        const retryable = timedOut || isTransientNetworkError(cause);
        if (!retryable || attempt === MAX_TRANSIENT_ATTEMPTS) {
          throw new Error(
            timedOut
              ? `GitHub GraphQL request timed out after ${this.#requestTimeoutMs}ms (${attempt}/${MAX_TRANSIENT_ATTEMPTS})`
              : `GitHub GraphQL network request failed (${attempt}/${MAX_TRANSIENT_ATTEMPTS})`,
            { cause },
          );
        }
        await retryDelay(this.#retryBaseDelayMs * 2 ** (attempt - 1));
        continue;
      } finally {
        clearTimeout(timeout);
      }
      const retryableStatus = [502, 503, 504].includes(response.status);
      if (retryableStatus && attempt < MAX_TRANSIENT_ATTEMPTS) {
        await retryDelay(this.#retryBaseDelayMs * 2 ** (attempt - 1));
        continue;
      }

      try {
        payload = JSON.parse(responseBody);
        parsedResponse = true;
        break;
      } catch (cause) {
        const contentType = response.headers.get("content-type");
        const retryableMalformedJson =
          response.ok && isJsonContentType(contentType);
        if (retryableMalformedJson && attempt < MAX_TRANSIENT_ATTEMPTS) {
          await retryDelay(this.#retryBaseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        // error-policy:J2 Retain the HTTP boundary context for malformed or
        // non-JSON API failures; exhausted malformed-JSON retries fail closed.
        throw new Error(
          retryableMalformedJson
            ? `GitHub GraphQL HTTP ${response.status} returned malformed JSON (${attempt}/${MAX_TRANSIENT_ATTEMPTS}; ${contentType ?? "unknown content type"})`
            : `GitHub GraphQL HTTP ${response.status} returned a non-JSON response (${contentType ?? "unknown content type"})`,
          { cause },
        );
      }
    }
    if (!response || !parsedResponse) {
      throw new Error("GitHub GraphQL request did not produce a response");
    }
    const envelope = asRecord(payload, "GitHub GraphQL response");
    if (!response.ok) {
      throw new Error(
        `GitHub GraphQL HTTP ${response.status}: ${sanitizeGraphqlError(envelope.message)}`,
      );
    }
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      const errors = envelope.errors.map(sanitizeGraphqlError).join("; ");
      throw new Error(
        `GitHub GraphQL rejected the leaderboard query: ${errors}`,
      );
    }
    const data = asRecord(envelope.data, "GitHub GraphQL response.data");
    const rateLimit = parseRateLimit(data.rateLimit);
    this.#startingRemaining =
      this.#startingRemaining ?? rateLimit.remaining + rateLimit.cost;
    this.#consumedCost = Math.max(
      this.#consumedCost + rateLimit.cost,
      this.#startingRemaining - rateLimit.remaining,
    );
    this.#rateLimit = {
      ...rateLimit,
      consumedDuringRun: this.#consumedCost,
    };
    const effectiveMaxGenerationCost = this.#effectiveMaxGenerationCost();
    if (
      this.#consumedCost > effectiveMaxGenerationCost ||
      rateLimit.remaining < this.#minimumRateLimitReserve
    ) {
      throw new Error(
        `GitHub GraphQL safety budget exceeded (${this.#consumedCost}/${effectiveMaxGenerationCost} points consumed, ${rateLimit.remaining} remaining; reserve ${this.#minimumRateLimitReserve})`,
      );
    }
    return data;
  }

  getRequestCount(): number {
    return this.#requestCount;
  }

  getRateLimit(): RateLimitSnapshot {
    if (!this.#rateLimit) {
      throw new Error("GitHub rate-limit metadata was not loaded");
    }
    return this.#rateLimit;
  }
}

async function loadGhToken(): Promise<string> {
  const process = Bun.spawn(["gh", "auth", "token"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `GITHUB_TOKEN is unset and gh auth token failed: ${stderr.trim().slice(0, 300)}`,
    );
  }
  const token = stdout.trim();
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is unset and gh auth token returned no token",
    );
  }
  return token;
}

export async function resolveGitHubToken(
  environment: Record<string, string | undefined> = Bun.env,
  ghTokenLoader: () => Promise<string> = loadGhToken,
): Promise<string> {
  const token = environment.GITHUB_TOKEN?.trim();
  return token || (await ghTokenLoader());
}

function parseIsoDate(value: Date, path: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${path} must be a valid date`);
  }
  return new Date(Math.floor(value.getTime() / 1000) * 1000);
}

function searchRange(from: Date, to: Date): string {
  const inclusiveEnd = new Date(to.getTime() - 1000);
  return `${from.toISOString()}..${inclusiveEnd.toISOString()}`;
}

function midpoint(from: Date, to: Date): Date {
  const seconds = Math.floor((to.getTime() - from.getTime()) / 2000);
  return new Date(from.getTime() + Math.max(1, seconds) * 1000);
}

function parseSearchReference(
  value: unknown,
  path: string,
  expectedKind: NodeReference["kind"],
): NodeReference {
  const node = asRecord(value, path);
  const kind = asString(node.__typename, `${path}.__typename`);
  if (kind !== expectedKind) {
    throw new Error(`${path} must be a ${expectedKind}`);
  }
  return {
    id: asString(node.id, `${path}.id`),
    kind,
    outcome:
      kind === "PullRequest" ? parsePullRequestOutcome(node, path) : null,
    openVersion: null,
  };
}

function parseOpenReference(
  value: unknown,
  path: string,
  kind: NodeReference["kind"],
): NodeReference {
  const node = asRecord(value, path);
  const updatedAt = asString(node.updatedAt, `${path}.updatedAt`);
  const headRefOid =
    kind === "PullRequest"
      ? asFullCommitSha(node.headRefOid, `${path}.headRefOid`)
      : null;
  return {
    id: asString(node.id, `${path}.id`),
    kind,
    outcome: null,
    openVersion: `${updatedAt}:${headRefOid ?? ""}`,
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function preflightRepository(
  client: GraphqlExecutor,
): Promise<{ id: string; updatedAt: string }> {
  const data = await client.execute(PREFLIGHT_QUERY);
  const repository = child(data, "repository", "data");
  const rateLimit = client.getRateLimit();
  const requiredRemaining = Math.min(
    MINIMUM_STARTING_RATE_LIMIT,
    rateLimit.limit - MINIMUM_RATE_LIMIT_RESERVE,
  );
  if (rateLimit.remaining < requiredRemaining) {
    throw new Error(
      `GitHub GraphQL has only ${rateLimit.remaining} points remaining; at least ${requiredRemaining} are required to start a complete snapshot`,
    );
  }
  return {
    id: asString(repository.id, "data.repository.id"),
    updatedAt: asString(repository.updatedAt, "data.repository.updatedAt"),
  };
}

export async function collectSearchReferences(
  client: GraphqlExecutor,
  from: Date,
  to: Date,
  qualifier: "closed" | "merged",
  kindQualifier: "is:issue is:closed" | "is:pr is:merged",
  expectedKind: NodeReference["kind"],
  stats: { searchSliceCount: number },
): Promise<NodeReference[]> {
  const searchQuery = `repo:${LEADERBOARD_REPOSITORY} ${kindQualifier} ${qualifier}:${searchRange(from, to)}`;
  stats.searchSliceCount += 1;
  const firstData = await client.execute(SEARCH_REFERENCES_QUERY, {
    searchQuery,
    after: null,
    pageSize: GRAPHQL_PAGE_SIZE,
  });
  const firstPage = parseSearchPage(firstData, (value, path) =>
    parseSearchReference(value, path, expectedKind),
  );
  if (firstPage.totalCount >= SEARCH_SAFE_RESULT_LIMIT) {
    if (to.getTime() - from.getTime() <= MINIMUM_SEARCH_SLICE_MS) {
      throw new Error(
        `GitHub Search returned ${firstPage.totalCount} results in one minute (${searchRange(from, to)}); refusing a snapshot that could hit the 1,000-result cap`,
      );
    }
    const split = midpoint(from, to);
    const left = await collectSearchReferences(
      client,
      from,
      split,
      qualifier,
      kindQualifier,
      expectedKind,
      stats,
    );
    const right = await collectSearchReferences(
      client,
      split,
      to,
      qualifier,
      kindQualifier,
      expectedKind,
      stats,
    );
    return dedupeByNodeId([...left, ...right]);
  }

  const references = [...firstPage.nodes];
  const expectedCount = firstPage.totalCount;
  let pageInfo = firstPage.pageInfo;
  while (pageInfo.hasNextPage) {
    if (!pageInfo.endCursor) {
      throw new Error("GitHub Search reported another page without a cursor");
    }
    const data = await client.execute(SEARCH_REFERENCES_QUERY, {
      searchQuery,
      after: pageInfo.endCursor,
      pageSize: GRAPHQL_PAGE_SIZE,
    });
    const page = parseSearchPage(data, (value, path) =>
      parseSearchReference(value, path, expectedKind),
    );
    if (page.totalCount !== expectedCount) {
      throw new Error(
        `GitHub Search changed from ${expectedCount} to ${page.totalCount} results while collecting ${searchRange(from, to)}; rerun for a coherent snapshot`,
      );
    }
    references.push(...page.nodes);
    pageInfo = page.pageInfo;
  }

  const deduped = dedupeByNodeId(references);
  if (deduped.length !== expectedCount) {
    throw new Error(
      `GitHub Search returned ${deduped.length} unique references but reported ${expectedCount} for ${searchRange(from, to)}`,
    );
  }
  return deduped;
}

async function countSearchResults(
  client: GraphqlExecutor,
  from: Date,
  to: Date,
  qualifier: "closed" | "merged",
  kindQualifier: "is:issue is:closed" | "is:pr is:merged",
  expectedKind: NodeReference["kind"],
  stats: { searchSliceCount: number },
): Promise<number> {
  const searchQuery = `repo:${LEADERBOARD_REPOSITORY} ${kindQualifier} ${qualifier}:${searchRange(from, to)}`;
  stats.searchSliceCount += 1;
  const data = await client.execute(SEARCH_REFERENCES_QUERY, {
    searchQuery,
    after: null,
    pageSize: 1,
  });
  return parseSearchPage(data, (value, path) =>
    parseSearchReference(value, path, expectedKind),
  ).totalCount;
}

async function collectOpenReferences(
  client: GraphqlExecutor,
  document: string,
  field: "issues" | "pullRequests",
  kind: NodeReference["kind"],
): Promise<{ repositoryId: string; references: NodeReference[] }> {
  const references: NodeReference[] = [];
  let after: string | null = null;
  let expectedCount: number | null = null;
  let repositoryId: string | null = null;
  do {
    const data = await client.execute(document, {
      after,
      pageSize: GRAPHQL_PAGE_SIZE,
    });
    const result = parseRepositoryConnection(data, field, (value, path) =>
      parseOpenReference(value, path, kind),
    );
    repositoryId = repositoryId ?? result.repositoryId;
    if (repositoryId !== result.repositoryId) {
      throw new Error("GitHub repository identity changed during collection");
    }
    expectedCount = expectedCount ?? result.page.totalCount;
    if (result.page.totalCount !== expectedCount) {
      throw new Error(
        `Open ${field} changed from ${expectedCount} to ${result.page.totalCount} while listing; rerun for a coherent snapshot`,
      );
    }
    references.push(...result.page.nodes);
    if (result.page.pageInfo.hasNextPage && !result.page.pageInfo.endCursor) {
      throw new Error(`${field} reported another page without a cursor`);
    }
    after = result.page.pageInfo.hasNextPage
      ? result.page.pageInfo.endCursor
      : null;
  } while (after);

  if (!repositoryId || expectedCount === null) {
    throw new Error(`GitHub did not return repository metadata for ${field}`);
  }
  const deduped = dedupeByNodeId(references);
  if (deduped.length !== expectedCount) {
    throw new Error(
      `Open ${field} changed during listing: expected ${expectedCount}, received ${deduped.length} unique references`,
    );
  }
  return { repositoryId, references: deduped };
}

function validateRecordState(
  parsed: ParsedIssue | ParsedPullRequest,
  expectedState: ExpectedRecordState,
): void {
  if (
    (expectedState === "open" && parsed.state !== "OPEN") ||
    (expectedState === "merged" &&
      ("mergedAt" in parsed.record ? parsed.record.mergedAt === null : true)) ||
    (expectedState === "closed" &&
      ("closedAt" in parsed.record ? parsed.record.closedAt === null : true))
  ) {
    const message = `GitHub node ${parsed.record.id} changed state during collection; expected ${expectedState}`;
    if (expectedState === "open") {
      throw new OpenSetChangedError(message);
    }
    throw new Error(message);
  }
}

function parsePullRequestOutcome(
  value: unknown,
  path: string,
): MergedPullRequestOutcome {
  const node = asRecord(value, path);
  if (node.__typename !== "PullRequest") {
    throw new Error(`${path} must be a PullRequest`);
  }
  if (asString(node.state, `${path}.state`) !== "MERGED") {
    throw new Error(`${path} changed state during outcome collection`);
  }
  const mergedAt = asNullableString(node.mergedAt, `${path}.mergedAt`);
  if (!mergedAt) {
    throw new Error(`${path}.mergedAt must be present`);
  }
  return {
    id: asString(node.id, `${path}.id`),
    number: asNumber(node.number, `${path}.number`),
    title: asString(node.title, `${path}.title`),
    url: asString(node.url, `${path}.url`),
    body: asString(node.body, `${path}.body`),
    createdAt: asString(node.createdAt, `${path}.createdAt`),
    updatedAt: asString(node.updatedAt, `${path}.updatedAt`),
    mergedAt,
    author: parseActor(node.author, `${path}.author`),
    additions: asNumber(node.additions, `${path}.additions`),
    deletions: asNumber(node.deletions, `${path}.deletions`),
  };
}

function parseDetailBatch<T extends ParsedIssue | ParsedPullRequest>(
  data: JsonRecord,
  ids: string[],
  expectedKind: NodeReference["kind"],
  parser: (value: unknown, path: string) => T,
): T[] {
  const nodes = asArray(data.nodes, "data.nodes");
  if (nodes.length !== ids.length) {
    throw new Error(
      `GitHub details returned ${nodes.length} nodes for ${ids.length} requested IDs`,
    );
  }
  return nodes.map((value, index) => {
    const path = `data.nodes[${index}]`;
    const node = asRecord(value, path);
    if (node.__typename !== expectedKind) {
      throw new Error(`${path} must be a ${expectedKind}`);
    }
    const parsed = parser(node, path);
    if (parsed.record.id !== ids[index]) {
      throw new Error(
        `${path}.id did not match the requested immutable node ID`,
      );
    }
    return parsed;
  });
}

async function completePullRequestConnections(
  client: GraphqlExecutor,
  parsed: ParsedPullRequest,
): Promise<PendingPullRequestRecord> {
  const pullRequest = parsed.record;

  let commentsState = parsed.pages.comments;
  while (commentsState.pageInfo.hasNextPage) {
    if (!commentsState.pageInfo.endCursor) {
      throw new Error(`PR #${pullRequest.number} comments cursor is missing`);
    }
    const data = await client.execute(MORE_PULL_REQUEST_COMMENTS_QUERY, {
      id: pullRequest.id,
      after: commentsState.pageInfo.endCursor,
    });
    const page = parseComments(
      child(data, "node", "data").comments,
      "data.node.comments",
      pullRequest.id,
    );
    pullRequest.comments.push(...page.nodes);
    commentsState = pageState(page);
  }

  let reviewsState = parsed.pages.reviews;
  while (reviewsState.pageInfo.hasNextPage) {
    if (!reviewsState.pageInfo.endCursor) {
      throw new Error(`PR #${pullRequest.number} reviews cursor is missing`);
    }
    const data = await client.execute(MORE_REVIEWS_QUERY, {
      id: pullRequest.id,
      after: reviewsState.pageInfo.endCursor,
    });
    const node = child(data, "node", "data");
    if (asString(node.id, "data.node.id") !== pullRequest.id) {
      throw new Error(
        `PR #${pullRequest.number} changed identity during review pagination`,
      );
    }
    if (
      asFullCommitSha(node.headRefOid, "data.node.headRefOid") !==
      pullRequest.headRefOid
    ) {
      throw new OpenSetChangedError(
        `PR #${pullRequest.number} changed head during review pagination`,
      );
    }
    const page = parseReviews(node.reviews, "data.node.reviews");
    pullRequest.reviews.push(...page.nodes);
    reviewsState = pageState(page);
  }

  let filesState = parsed.pages.files;
  while (filesState.pageInfo.hasNextPage) {
    if (!filesState.pageInfo.endCursor) {
      throw new Error(`PR #${pullRequest.number} files cursor is missing`);
    }
    const data = await client.execute(MORE_FILES_QUERY, {
      id: pullRequest.id,
      after: filesState.pageInfo.endCursor,
    });
    const page = parseFiles(
      child(data, "node", "data").files,
      "data.node.files",
    );
    pullRequest.files.push(...page.nodes);
    filesState = pageState(page);
  }

  let closingState = parsed.pages.closingIssues;
  while (closingState.pageInfo.hasNextPage) {
    if (!closingState.pageInfo.endCursor) {
      throw new Error(
        `PR #${pullRequest.number} closing-issues cursor is missing`,
      );
    }
    const data = await client.execute(MORE_CLOSING_ISSUES_QUERY, {
      id: pullRequest.id,
      after: closingState.pageInfo.endCursor,
    });
    const page = parseClosingIssueIds(
      child(data, "node", "data").closingIssuesReferences,
      "data.node.closingIssuesReferences",
    );
    pullRequest.closingIssueIds.push(...page.nodes.map((issue) => issue.id));
    closingState = pageState(page);
  }

  pullRequest.comments = dedupeByNodeId(pullRequest.comments);
  pullRequest.reviews = dedupeByNodeId(pullRequest.reviews);
  pullRequest.closingIssueIds = [...new Set(pullRequest.closingIssueIds)];
  if (
    pullRequest.comments.length !== parsed.pages.comments.totalCount ||
    pullRequest.reviews.length !== parsed.pages.reviews.totalCount ||
    pullRequest.files.length !== parsed.pages.files.totalCount ||
    pullRequest.closingIssueIds.length !== parsed.pages.closingIssues.totalCount
  ) {
    throw new Error(
      `PR #${pullRequest.number} changed during collection; nested connection totals no longer match`,
    );
  }
  return pullRequest;
}

async function completeIssueConnections(
  client: GraphqlExecutor,
  parsed: ParsedIssue,
): Promise<IssueRecord> {
  const issue = parsed.record;
  let commentsState = parsed.pages.comments;
  while (commentsState.pageInfo.hasNextPage) {
    if (!commentsState.pageInfo.endCursor) {
      throw new Error(`Issue #${issue.number} comments cursor is missing`);
    }
    const data = await client.execute(MORE_ISSUE_COMMENTS_QUERY, {
      id: issue.id,
      after: commentsState.pageInfo.endCursor,
    });
    const page = parseComments(
      child(data, "node", "data").comments,
      "data.node.comments",
      issue.id,
    );
    issue.comments.push(...page.nodes);
    commentsState = pageState(page);
  }

  let closingState = parsed.pages.closedByPullRequests;
  while (closingState.pageInfo.hasNextPage) {
    if (!closingState.pageInfo.endCursor) {
      throw new Error(
        `Issue #${issue.number} closing-pull-requests cursor is missing`,
      );
    }
    const data = await client.execute(MORE_CLOSING_PULL_REQUESTS_QUERY, {
      id: issue.id,
      after: closingState.pageInfo.endCursor,
    });
    const page = parseClosingPullRequests(
      child(data, "node", "data").closedByPullRequestsReferences,
      "data.node.closedByPullRequestsReferences",
    );
    issue.closedByPullRequests.push(...page.nodes);
    closingState = pageState(page);
  }

  issue.comments = dedupeByNodeId(issue.comments);
  issue.closedByPullRequests = dedupeByNodeId(issue.closedByPullRequests);
  if (
    issue.comments.length !== parsed.pages.comments.totalCount ||
    issue.closedByPullRequests.length !==
      parsed.pages.closedByPullRequests.totalCount
  ) {
    throw new Error(
      `Issue #${issue.number} changed during collection; nested connection totals no longer match`,
    );
  }
  return issue;
}

async function completeInlineReviewComments(
  client: GraphqlExecutor,
  reviewId: string,
  artifactId: string,
  firstPage: ConnectionPage<GitHubTextSource>,
): Promise<GitHubTextSource[]> {
  const comments = [...firstPage.nodes];
  let pageInfo = firstPage.pageInfo;
  while (pageInfo.hasNextPage) {
    if (!pageInfo.endCursor) {
      throw new Error(`Review ${reviewId} comments cursor is missing`);
    }
    const data = await client.execute(MORE_REVIEW_INLINE_COMMENTS_QUERY, {
      id: reviewId,
      after: pageInfo.endCursor,
    });
    const node = child(data, "node", "data");
    if (asString(node.id, "data.node.id") !== reviewId) {
      throw new Error(`Review ${reviewId} changed identity during pagination`);
    }
    const page = parseComments(node.comments, "data.node.comments", artifactId);
    comments.push(...page.nodes);
    pageInfo = page.pageInfo;
  }
  const deduped = dedupeByNodeId(comments);
  if (deduped.length !== firstPage.totalCount) {
    throw new Error(
      `Review ${reviewId} changed during collection; expected ${firstPage.totalCount} inline comments, received ${deduped.length}`,
    );
  }
  return deduped;
}

export function deriveCurrentHeadReviewDecision(
  headRefOid: string,
  pullRequestAuthor: GitHubActor | null,
  reviews: Array<{
    id: string;
    state: string;
    submittedAt: string | null;
    commitId: string | null;
    author: GitHubActor | null;
  }>,
): PullRequestRecord["reviewDecision"] {
  const currentHead = asFullCommitSha(headRefOid, "Pull request headRefOid");
  const latestReviewsByActor = new Map<
    string,
    { submittedAt: number; reviews: Array<(typeof reviews)[number]> }
  >();
  for (const review of reviews) {
    const commitId =
      review.commitId === null
        ? null
        : asFullCommitSha(review.commitId, `Review ${review.id} commitId`);
    const isDecision = ["APPROVED", "CHANGES_REQUESTED"].includes(review.state);
    const isSelfReview =
      review.author !== null &&
      pullRequestAuthor !== null &&
      (review.author.id === pullRequestAuthor.id ||
        review.author.login.toLowerCase() ===
          pullRequestAuthor.login.toLowerCase());
    if (isBotActor(review.author) || isSelfReview) {
      continue;
    }
    if (isDecision && (!review.submittedAt || commitId === null)) {
      throw new Error(
        `Review ${review.id} cannot prove a current-head ${review.state} decision`,
      );
    }
    if (
      !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state) ||
      !review.submittedAt ||
      commitId === null
    ) {
      continue;
    }
    const submittedAt = Date.parse(review.submittedAt);
    if (!Number.isFinite(submittedAt)) {
      throw new Error(`Review ${review.id} has an invalid submittedAt value`);
    }
    const actorKey = review.author
      ? `actor:${review.author.id}`
      : `ghost:${review.id}`;
    const previous = latestReviewsByActor.get(actorKey);
    if (!previous || submittedAt > previous.submittedAt) {
      latestReviewsByActor.set(actorKey, {
        submittedAt,
        reviews: [{ ...review, commitId }],
      });
    } else if (submittedAt === previous.submittedAt) {
      previous.reviews.push({ ...review, commitId });
    }
  }
  const currentHeadStates = [...latestReviewsByActor.values()]
    .flatMap((entry) => entry.reviews)
    .filter((review) => review.commitId === currentHead)
    .map((review) => review.state);
  return currentHeadStates.includes("CHANGES_REQUESTED")
    ? "CHANGES_REQUESTED"
    : currentHeadStates.includes("APPROVED")
      ? "APPROVED"
      : null;
}

async function finalizePullRequests(
  client: GraphqlExecutor,
  pending: PendingPullRequestRecord[],
): Promise<PullRequestRecord[]> {
  const bindings = pending.flatMap((pullRequest) =>
    pullRequest.reviews.map((review) => ({
      artifactId: pullRequest.id,
      pullRequest,
      review,
    })),
  );
  const seenReviewIds = new Set<string>();
  for (const binding of bindings) {
    if (seenReviewIds.has(binding.review.id)) {
      throw new Error(
        `Review ${binding.review.id} appeared under more than one pull request`,
      );
    }
    seenReviewIds.add(binding.review.id);
  }
  const commentCounts = new Map<string, number>();
  for (const batch of chunks(bindings, REVIEW_DETAIL_BATCH_SIZE)) {
    const ids = batch.map((binding) => binding.review.id);
    const data = await client.execute(REVIEW_INLINE_COMMENTS_QUERY, { ids });
    const nodes = asArray(data.nodes, "data.nodes");
    if (nodes.length !== batch.length) {
      throw new Error(
        `GitHub returned ${nodes.length} reviews for ${batch.length} requested IDs`,
      );
    }
    for (const [index, binding] of batch.entries()) {
      const path = `data.nodes[${index}]`;
      const node = asRecord(nodes[index], path);
      if (
        node.__typename !== "PullRequestReview" ||
        asString(node.id, `${path}.id`) !== binding.review.id
      ) {
        throw new Error(`${path} did not match the requested review`);
      }
      const firstPage = parseComments(
        node.comments,
        `${path}.comments`,
        binding.artifactId,
      );
      const comments = await completeInlineReviewComments(
        client,
        binding.review.id,
        binding.artifactId,
        firstPage,
      );
      binding.pullRequest.comments.push(...comments);
      commentCounts.set(binding.review.id, comments.length);
    }
  }

  return pending.map((pendingPullRequest) => {
    const {
      headRefOid,
      reviews: pendingReviews,
      ...pullRequest
    } = pendingPullRequest;
    const reviewDecision = deriveCurrentHeadReviewDecision(
      headRefOid,
      pullRequest.author,
      pendingReviews,
    );
    const reviews = pendingReviews.map((review) => {
      const inlineCommentCount = commentCounts.get(review.id);
      if (inlineCommentCount === undefined) {
        throw new Error(`Review ${review.id} inline comments were not loaded`);
      }
      return {
        id: review.id,
        body: review.body,
        state: review.state,
        submittedAt: review.submittedAt,
        url: review.url,
        author: review.author,
        inlineCommentCount,
      };
    });
    return {
      ...pullRequest,
      headRefOid,
      reviewDecision,
      comments: dedupeByNodeId(pullRequest.comments),
      reviews,
    };
  });
}

async function hydratePullRequests(
  client: GraphqlExecutor,
  references: NodeReference[],
  expectedState: ExpectedRecordState,
  onProgress: (progress: GenerationProgress) => void,
  phase: GenerationProgress["phase"],
): Promise<PullRequestRecord[]> {
  const pending: PendingPullRequestRecord[] = [];
  for (const batch of chunks(references, DETAIL_BATCH_SIZE)) {
    const ids = batch.map((reference) => reference.id);
    const data = await client.execute(PULL_REQUEST_DETAILS_QUERY, { ids });
    const parsed = parseDetailBatch(data, ids, "PullRequest", parsePullRequest);
    for (const value of parsed) {
      validateRecordState(value, expectedState);
      pending.push(await completePullRequestConnections(client, value));
      onProgress({
        phase,
        completed: pending.length,
        total: references.length,
      });
    }
  }
  const pullRequests = await finalizePullRequests(client, pending);
  onProgress({
    phase,
    completed: pullRequests.length,
    total: references.length,
  });
  return pullRequests;
}

async function hydrateIssues(
  client: GraphqlExecutor,
  references: NodeReference[],
  expectedState: ExpectedRecordState,
  onProgress: (progress: GenerationProgress) => void,
  phase: GenerationProgress["phase"],
): Promise<IssueRecord[]> {
  const issues: IssueRecord[] = [];
  for (const batch of chunks(references, DETAIL_BATCH_SIZE)) {
    const ids = batch.map((reference) => reference.id);
    const data = await client.execute(ISSUE_DETAILS_QUERY, { ids });
    const parsed = parseDetailBatch(data, ids, "Issue", parseIssue);
    for (const value of parsed) {
      validateRecordState(value, expectedState);
      issues.push(await completeIssueConnections(client, value));
      onProgress({
        phase,
        completed: issues.length,
        total: references.length,
      });
    }
  }
  return issues;
}

export function sameReferenceSet(
  left: NodeReference[],
  right: NodeReference[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightIds = new Set(right.map((reference) => reference.id));
  const rightVersions = new Map(
    right.map((reference) => [reference.id, reference.openVersion]),
  );
  return left.every(
    (reference) =>
      rightIds.has(reference.id) &&
      rightVersions.get(reference.id) === reference.openVersion,
  );
}

async function collectStableOpenIssues(
  client: GraphqlExecutor,
  repositoryId: string,
  onProgress: (progress: GenerationProgress) => void,
): Promise<IssueRecord[]> {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
    const before = await collectOpenReferences(
      client,
      OPEN_ISSUE_REFERENCES_QUERY,
      "issues",
      "Issue",
    );
    if (before.repositoryId !== repositoryId) {
      throw new Error("GitHub returned an inconsistent repository node ID");
    }
    assertEstimatedBudget(client, 0, before.references.length);
    try {
      const records = await hydrateIssues(
        client,
        before.references,
        "open",
        onProgress,
        "open-issues",
      );
      const after = await collectOpenReferences(
        client,
        OPEN_ISSUE_REFERENCES_QUERY,
        "issues",
        "Issue",
      );
      if (
        after.repositoryId === repositoryId &&
        sameReferenceSet(before.references, after.references)
      ) {
        return records;
      }
    } catch (error) {
      // error-policy:J1 The GitHub collection boundary retries only a typed
      // concurrent-set change and fails after the bounded retry window.
      if (!(error instanceof OpenSetChangedError)) {
        throw error;
      }
    }
  }
  throw new Error(
    `Open issue set changed during ${MAX_TRANSIENT_ATTEMPTS} consecutive collection attempts`,
  );
}

async function collectStableOpenPullRequests(
  client: GraphqlExecutor,
  repositoryId: string,
  onProgress: (progress: GenerationProgress) => void,
): Promise<PullRequestRecord[]> {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
    const before = await collectOpenReferences(
      client,
      OPEN_PULL_REQUEST_REFERENCES_QUERY,
      "pullRequests",
      "PullRequest",
    );
    if (before.repositoryId !== repositoryId) {
      throw new Error("GitHub returned an inconsistent repository node ID");
    }
    assertEstimatedBudget(client, before.references.length, 0);
    try {
      const records = await hydratePullRequests(
        client,
        before.references,
        "open",
        onProgress,
        "open-pull-requests",
      );
      const after = await collectOpenReferences(
        client,
        OPEN_PULL_REQUEST_REFERENCES_QUERY,
        "pullRequests",
        "PullRequest",
      );
      if (
        after.repositoryId === repositoryId &&
        sameReferenceSet(before.references, after.references)
      ) {
        return records;
      }
    } catch (error) {
      // error-policy:J1 The GitHub collection boundary retries only a typed
      // concurrent-set change and fails after the bounded retry window.
      if (!(error instanceof OpenSetChangedError)) {
        throw error;
      }
    }
  }
  throw new Error(
    `Open pull-request set changed during ${MAX_TRANSIENT_ATTEMPTS} consecutive collection attempts`,
  );
}

export async function assertOpenPullRequestReferencesCurrent(
  client: GraphqlExecutor,
  repositoryId: string,
  pullRequests: PullRequestRecord[],
): Promise<void> {
  const current = await collectOpenReferences(
    client,
    OPEN_PULL_REQUEST_REFERENCES_QUERY,
    "pullRequests",
    "PullRequest",
  );
  const expected: NodeReference[] = pullRequests.map((pullRequest) => ({
    id: pullRequest.id,
    kind: "PullRequest",
    outcome: null,
    openVersion: `${pullRequest.updatedAt}:${pullRequest.headRefOid}`,
  }));
  if (
    current.repositoryId !== repositoryId ||
    !sameReferenceSet(expected, current.references)
  ) {
    throw new Error(
      "Open pull-request set changed during evidence verification",
    );
  }
}

export async function assertOpenIssueReferencesCurrent(
  client: GraphqlExecutor,
  repositoryId: string,
  issues: IssueRecord[],
): Promise<void> {
  const current = await collectOpenReferences(
    client,
    OPEN_ISSUE_REFERENCES_QUERY,
    "issues",
    "Issue",
  );
  const expected: NodeReference[] = issues.map((issue) => ({
    id: issue.id,
    kind: "Issue",
    outcome: null,
    openVersion: `${issue.updatedAt}:`,
  }));
  if (
    current.repositoryId !== repositoryId ||
    !sameReferenceSet(expected, current.references)
  ) {
    throw new Error("Open issue set changed during evidence verification");
  }
}

export async function assertOpenWorkReferencesCurrent(
  client: GraphqlExecutor,
  repositoryId: string,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
): Promise<void> {
  await assertOpenIssueReferencesCurrent(client, repositoryId, issues);
  await assertOpenPullRequestReferencesCurrent(
    client,
    repositoryId,
    pullRequests,
  );
}

function estimateBatchedConnectionCost(
  count: number,
  connectionsPerNode: number,
): number {
  return chunks(
    Array.from({ length: count }, (_, index) => index),
    DETAIL_BATCH_SIZE,
  ).reduce(
    (total, batch) =>
      total +
      Math.max(1, Math.round((batch.length * connectionsPerNode) / 100)),
    0,
  );
}

export function estimateFirstPageDetailCost(
  pullRequestCount: number,
  issueCount: number,
): number {
  if (
    !Number.isInteger(pullRequestCount) ||
    pullRequestCount < 0 ||
    !Number.isInteger(issueCount) ||
    issueCount < 0
  ) {
    throw new Error("Detail-cost counts must be non-negative integers");
  }
  return (
    estimateBatchedConnectionCost(pullRequestCount, 6) +
    estimateBatchedConnectionCost(issueCount, 4)
  );
}

function assertEstimatedBudget(
  client: GraphqlExecutor,
  pullRequestCount: number,
  issueCount: number,
): void {
  const rateLimit = client.getRateLimit();
  const estimate = estimateFirstPageDetailCost(pullRequestCount, issueCount);
  const available = Math.min(
    MAX_GENERATION_COST - rateLimit.consumedDuringRun,
    rateLimit.remaining - MINIMUM_RATE_LIMIT_RESERVE,
  );
  if (estimate > available) {
    throw new Error(
      `Estimated first-page detail cost ${estimate} exceeds the safe GraphQL budget ${available}; no partial snapshot will be written`,
    );
  }
}

export function deriveSourceUpdatedAt(
  records: Array<{ updatedAt: string }>,
  emptyFallback: string,
): string {
  if (records.length === 0) {
    return emptyFallback;
  }
  return records
    .slice(1)
    .reduce(
      (latest, record) =>
        Date.parse(record.updatedAt) > Date.parse(latest)
          ? record.updatedAt
          : latest,
      records[0].updatedAt,
    );
}

const SCORE_EVIDENCE_ROWS: ReadonlyArray<{
  id: string;
  label: string;
  category: EvidenceCategory;
}> = [
  {
    id: "before-screenshots",
    label: "Before screenshots",
    category: "screenshot",
  },
  {
    id: "after-screenshots",
    label: "After screenshots",
    category: "screenshot",
  },
  {
    id: "walkthrough-video",
    label: "Walkthrough video",
    category: "video",
  },
  { id: "backend-logs", label: "Backend logs", category: "logs" },
  { id: "frontend-logs", label: "Frontend logs", category: "logs" },
  {
    id: "llm-trajectory",
    label: "Real-LLM trajectory",
    category: "trajectory",
  },
  {
    id: "domain-artifacts",
    label: "Domain artifacts",
    category: "domain-artifact",
  },
];

const SCORE_EVIDENCE_CATEGORY = new Map(
  SCORE_EVIDENCE_ROWS.map(({ category, id }) => [id, category]),
);

interface EvidenceVerificationCandidate {
  pullRequest: PullRequestRecord;
  source: GitHubTextSource;
  artifactCount: number;
}

function evidenceHeadOid(body: string): string | null {
  const matches = [
    ...body.matchAll(/<!--\s*evidence-head:([a-f0-9]{40})\s*-->/gi),
  ];
  return matches.length === 1 ? matches[0][1].toLowerCase() : null;
}

function evidenceVerificationCandidates(
  pullRequests: PullRequestRecord[],
): EvidenceVerificationCandidate[] {
  const candidates: EvidenceVerificationCandidate[] = [];
  for (const pullRequest of pullRequests) {
    const mergedAt = pullRequest.mergedAt
      ? Date.parse(pullRequest.mergedAt)
      : Number.POSITIVE_INFINITY;
    for (const source of pullRequestTextSources(pullRequest)) {
      if (
        source.kind !== "body" ||
        !source.author ||
        isBotActor(source.author) ||
        Date.parse(source.createdAt) > mergedAt ||
        Date.parse(source.updatedAt) > mergedAt
      ) {
        continue;
      }
      if (evidenceHeadOid(source.body) !== pullRequest.headRefOid) continue;
      const artifactCount = planReferencedArtifacts(
        source.body,
        SCORE_EVIDENCE_ROWS,
        { allowedArtifactKinds: ["opaque-upload"] },
      ).uniqueArtifactCount;
      if (artifactCount > 0) {
        candidates.push({ pullRequest, source, artifactCount });
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      left.pullRequest.id.localeCompare(right.pullRequest.id) ||
      left.source.id.localeCompare(right.source.id),
  );
}

async function mapWithFixedConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

interface CandidateEvidenceVerdict {
  artifacts: VerifiedEvidenceArtifact[];
  failedCategories: EvidenceCategory[];
}

export interface PullRequestEvidenceVerificationResult {
  artifacts: VerifiedEvidenceArtifact[];
  status: "complete" | "suppressed-limit";
  sourceCount: number;
  artifactCount: number;
}

/**
 * Resolves score-bearing proof from the exact, unchanged contributor-authored
 * source that existed at merge or at the stable open-PR snapshot. The root
 * evidence verifier owns URL trust, redirects, byte limits, and structure.
 */
export async function verifyPullRequestEvidence(
  pullRequests: PullRequestRecord[],
  options: Pick<
    GenerateOptions,
    "evidenceFetch" | "evidenceTimeoutMs" | "evidenceToken"
  > = {},
): Promise<PullRequestEvidenceVerificationResult> {
  const candidates = evidenceVerificationCandidates(pullRequests);
  const artifactCount = candidates.reduce(
    (total, candidate) => total + candidate.artifactCount,
    0,
  );

  const selectedCandidates: EvidenceVerificationCandidate[] = [];
  let selectedArtifactCount = 0;
  const candidatesByTrust = [...candidates].sort(
    (left, right) =>
      Number(left.pullRequest.mergedAt === null) -
        Number(right.pullRequest.mergedAt === null) ||
      left.artifactCount - right.artifactCount ||
      left.pullRequest.id.localeCompare(right.pullRequest.id) ||
      left.source.id.localeCompare(right.source.id),
  );
  for (const candidate of candidatesByTrust) {
    if (
      candidate.artifactCount > MAX_EVIDENCE_ARTIFACTS_PER_SOURCE ||
      selectedCandidates.length >= MAX_EVIDENCE_SOURCES_PER_SNAPSHOT ||
      selectedArtifactCount + candidate.artifactCount >
        MAX_EVIDENCE_ARTIFACTS_PER_SNAPSHOT
    ) {
      continue;
    }
    selectedCandidates.push(candidate);
    selectedArtifactCount += candidate.artifactCount;
  }
  const status =
    selectedCandidates.length === candidates.length
      ? "complete"
      : "suppressed-limit";

  const verdicts = await mapWithFixedConcurrency(
    selectedCandidates,
    EVIDENCE_VERIFICATION_CONCURRENCY,
    async ({ pullRequest, source }): Promise<CandidateEvidenceVerdict> => {
      const verification = await verifyReferencedArtifacts(
        source.body,
        SCORE_EVIDENCE_ROWS,
        {
          allowedArtifactKinds: ["opaque-upload"],
          concurrency: 1,
          contentDigestLimitBytes: EVIDENCE_CONTENT_DIGEST_LIMIT_BYTES,
          fetchImpl: options.evidenceFetch,
          timeoutMs: options.evidenceTimeoutMs ?? EVIDENCE_ARTIFACT_TIMEOUT_MS,
          token: options.evidenceToken,
        },
      );
      const failedCategories = new Set<EvidenceCategory>();
      for (const finding of verification.findings) {
        const category = SCORE_EVIDENCE_CATEGORY.get(finding.id);
        if (category && finding.status !== "ok") {
          failedCategories.add(category);
        }
      }
      const artifacts = verification.findings.flatMap((finding) => {
        const category = SCORE_EVIDENCE_CATEGORY.get(finding.id);
        if (
          finding.status !== "ok" ||
          !category ||
          failedCategories.has(category) ||
          finding.artifactKind !== "opaque-upload" ||
          !finding.contentSha256
        ) {
          return [];
        }
        let artifactUrl: URL;
        try {
          artifactUrl = new URL(finding.url);
        } catch {
          // error-policy:J3 verifier output is treated as untrusted boundary
          // data; a malformed URL cannot become a score-bearing identity.
          return [];
        }
        return [
          {
            pullRequestId: pullRequest.id,
            pullRequestMergedAt: pullRequest.mergedAt,
            pullRequestHeadOid: pullRequest.headRefOid,
            pullRequestUpdatedAt: pullRequest.updatedAt,
            sourceId: source.id,
            sourceBody: source.body,
            sourceUpdatedAt: source.updatedAt,
            category,
            artifactIdentity: `${artifactUrl.protocol}//${artifactUrl.hostname.toLowerCase()}${artifactUrl.pathname}`,
            contentSha256: finding.contentSha256,
          } satisfies VerifiedEvidenceArtifact,
        ];
      });
      return { artifacts, failedCategories: [...failedCategories] };
    },
  );
  const failedByPullRequest = new Set<string>();
  for (const [index, verdict] of verdicts.entries()) {
    const pullRequestId = selectedCandidates[index].pullRequest.id;
    for (const category of verdict.failedCategories) {
      failedByPullRequest.add(`${pullRequestId}\u0000${category}`);
    }
  }
  const remotelyVerified = verdicts
    .flatMap(({ artifacts }) => artifacts)
    .filter(
      (artifact) =>
        !failedByPullRequest.has(
          `${artifact.pullRequestId}\u0000${artifact.category}`,
        ),
    )
    .sort(
      (left, right) =>
        left.pullRequestId.localeCompare(right.pullRequestId) ||
        left.sourceId.localeCompare(right.sourceId) ||
        left.category.localeCompare(right.category) ||
        left.artifactIdentity.localeCompare(right.artifactIdentity),
    );
  const artifacts = selectUniqueVerifiedEvidence(
    remotelyVerified,
    pullRequests,
  );
  return {
    artifacts,
    status,
    sourceCount: candidates.length,
    artifactCount,
  };
}

export async function generateLeaderboardFromGitHub(
  client: GraphqlExecutor,
  options: GenerateOptions = {},
): Promise<LeaderboardSnapshot> {
  const now = parseIsoDate(options.now ?? new Date(), "now");
  const windowFrom = new Date(
    now.getTime() - SCORE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const verificationWindowFrom = new Date(
    now.getTime() - VERIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const onProgress = options.onProgress ?? (() => undefined);
  const stats = { searchSliceCount: 0 };

  const preflight = await preflightRepository(client);
  const mergedPullRequestReferences = await collectSearchReferences(
    client,
    windowFrom,
    now,
    "merged",
    "is:pr is:merged",
    "PullRequest",
    stats,
  );
  const closedIssueCount = await countSearchResults(
    client,
    windowFrom,
    now,
    "closed",
    "is:issue is:closed",
    "Issue",
    stats,
  );
  const closedIssueReferences = await collectSearchReferences(
    client,
    verificationWindowFrom,
    now,
    "closed",
    "is:issue is:closed",
    "Issue",
    stats,
  );
  const mergedPullRequestOutcomes = mergedPullRequestReferences.map(
    (reference) => {
      if (!reference.outcome) {
        throw new Error(
          `Merged pull request ${reference.id} is missing scalar outcome metadata`,
        );
      }
      return reference.outcome;
    },
  );
  const detailedMergedPullRequestIds = new Set(
    mergedPullRequestOutcomes
      .filter(
        (pullRequest) =>
          Date.parse(pullRequest.mergedAt) >= verificationWindowFrom.getTime(),
      )
      .map((pullRequest) => pullRequest.id),
  );
  const detailedMergedPullRequestReferences =
    mergedPullRequestReferences.filter((reference) =>
      detailedMergedPullRequestIds.has(reference.id),
    );
  assertEstimatedBudget(
    client,
    detailedMergedPullRequestReferences.length,
    closedIssueReferences.length,
  );

  const mergedPullRequests = await hydratePullRequests(
    client,
    detailedMergedPullRequestReferences,
    "merged",
    onProgress,
    "merged-pull-requests",
  );
  const closedIssues = await hydrateIssues(
    client,
    closedIssueReferences,
    "closed",
    onProgress,
    "resolved-issues",
  );
  const openIssues = await collectStableOpenIssues(
    client,
    preflight.id,
    onProgress,
  );
  const openPullRequests = await collectStableOpenPullRequests(
    client,
    preflight.id,
    onProgress,
  );
  const evidenceVerification = await verifyPullRequestEvidence(
    [...mergedPullRequests, ...openPullRequests],
    options,
  );
  await assertOpenWorkReferencesCurrent(
    client,
    preflight.id,
    openIssues,
    openPullRequests,
  );

  const allRecords = [
    ...mergedPullRequestOutcomes,
    ...mergedPullRequests,
    ...closedIssues,
    ...openIssues,
    ...openPullRequests,
  ];
  const fetchedAt = new Date().toISOString();
  const rateLimit = client.getRateLimit();
  const source: LeaderboardSourceMetadata = {
    provider: "github-graphql",
    fetchedAt,
    cutoffAt: now.toISOString(),
    repositoryId: preflight.id,
    requestCount: client.getRequestCount(),
    searchSliceCount: stats.searchSliceCount,
    rateLimit,
    counts: {
      mergedPullRequests: mergedPullRequestOutcomes.length,
      detailedMergedPullRequests: mergedPullRequests.length,
      closedIssues: closedIssueCount,
      detailedClosedIssues: closedIssues.length,
      resolvedIssues: 0,
      openIssues: openIssues.length,
      openPullRequests: openPullRequests.length,
    },
    verificationWindow: {
      days: VERIFICATION_WINDOW_DAYS,
      from: verificationWindowFrom.toISOString(),
      to: now.toISOString(),
    },
    evidenceVerification: {
      status: evidenceVerification.status,
      sourceCount: evidenceVerification.sourceCount,
      artifactCount: evidenceVerification.artifactCount,
      maxSources: MAX_EVIDENCE_SOURCES_PER_SNAPSHOT,
      maxArtifacts: MAX_EVIDENCE_ARTIFACTS_PER_SNAPSHOT,
    },
  };
  return createLeaderboardSnapshot({
    generatedAt: fetchedAt,
    windowFrom: windowFrom.toISOString(),
    windowTo: now.toISOString(),
    sourceUpdatedAt: deriveSourceUpdatedAt(allRecords, preflight.updatedAt),
    source,
    mergedPullRequestOutcomes,
    mergedPullRequests,
    closedIssueCount,
    resolvedIssues: closedIssues,
    openIssues,
    openPullRequests,
    verificationWindowFrom: verificationWindowFrom.toISOString(),
    verifiedEvidence: evidenceVerification.artifacts,
  });
}

export async function writeLeaderboardAtomically(
  snapshot: LeaderboardSnapshot,
  outputPath = DEFAULT_OUTPUT_PATH,
): Promise<void> {
  assertPublishableLeaderboardSnapshot(snapshot);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(temporaryPath, outputPath);
  } finally {
    // error-policy:J6 a failed atomic write may leave only its unique temporary file.
    await rm(temporaryPath, { force: true });
  }
}

export async function runGenerator(
  outputPath = DEFAULT_OUTPUT_PATH,
  dependencies: GeneratorDependencies = {
    getToken: resolveGitHubToken,
    createClient: (token) => new GitHubGraphqlClient(token),
    generate: generateLeaderboardFromGitHub,
    write: writeLeaderboardAtomically,
  },
  options: GenerateOptions = {},
): Promise<LeaderboardSnapshot> {
  const token = await dependencies.getToken();
  const client = dependencies.createClient(token);
  const snapshot = await dependencies.generate(client, {
    ...options,
    evidenceToken: options.evidenceToken ?? token,
  });
  await dependencies.write(snapshot, outputPath);
  return snapshot;
}

function progressLine(progress: GenerationProgress): string {
  const label = progress.phase.replaceAll("-", " ");
  return `[eliza.army] ${label}: ${progress.completed}/${progress.total}\n`;
}

if (import.meta.main) {
  const snapshot = await runGenerator(DEFAULT_OUTPUT_PATH, undefined, {
    onProgress: (progress) => {
      process.stderr.write(progressLine(progress));
    },
  });
  process.stdout.write(
    `[eliza.army] wrote ${DEFAULT_OUTPUT_PATH} (${snapshot.leaders.length} leaders, ${snapshot.ledger.length} score events, ${snapshot.source.requestCount} GraphQL requests, ${snapshot.source.rateLimit.remaining}/${snapshot.source.rateLimit.limit} points remaining)\n`,
  );
}
