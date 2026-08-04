import { randomUUID } from "node:crypto";
import { SupportedChain } from "../types";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlText,
  toText,
  type RuntimeDb,
} from "./sql";
import {
  ALLOWED_REVIEW_TRANSITIONS,
  type LabelMatchReference,
  type ReviewStatus,
  ReviewStateTransitionError,
  type ScamPatternCandidate,
  type ScamPatternCandidateInsert,
  type ScamPatternCandidateListFilter,
  ScamPatternCandidateNotFoundError,
  type ScamPatternCandidateResolution,
  type ScamPatternId,
  VALID_REVIEW_STATUSES,
  VALID_SCAM_PATTERN_IDS,
} from "./types";

const TABLE = "skunkscan.scam_pattern_candidates";

const SELECT_COLUMNS =
  "id, chain, address, patterns, evidence, has_known_label_match, label_matches, review_status, reviewed_by, reviewed_at, review_notes, created_at";

function parseReviewStatus(value: unknown): ReviewStatus {
  const text = toText(value);
  if (!VALID_REVIEW_STATUSES.has(text as ReviewStatus)) {
    throw new Error(`[ScamPatternCandidates] unknown review_status from db: ${text}`);
  }
  return text as ReviewStatus;
}

function parsePatterns(value: unknown): ScamPatternId[] {
  const patterns = parseJsonArray<string>(value);
  for (const pattern of patterns) {
    if (!VALID_SCAM_PATTERN_IDS.has(pattern as ScamPatternId)) {
      throw new Error(`[ScamPatternCandidates] unknown pattern id from db: ${pattern}`);
    }
  }
  return patterns as ScamPatternId[];
}

function parseTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  const text = toText(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`[ScamPatternCandidates] invalid timestamp from db: ${text}`);
  }
  return date;
}

function parseOptionalTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  return parseTimestamp(value);
}

function parseOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = toText(value);
  return text === "" ? null : text;
}

function rowToCandidate(row: Record<string, unknown>): ScamPatternCandidate {
  return {
    id: toText(row.id),
    chain: toText(row.chain) as SupportedChain,
    address: toText(row.address),
    patterns: parsePatterns(row.patterns),
    evidence: parseJsonRecord(row.evidence),
    hasKnownLabelMatch: row.has_known_label_match === true,
    labelMatches: parseJsonArray<LabelMatchReference>(row.label_matches),
    reviewStatus: parseReviewStatus(row.review_status),
    reviewedBy: parseOptionalText(row.reviewed_by),
    reviewedAt: parseOptionalTimestamp(row.reviewed_at),
    reviewNotes: parseOptionalText(row.review_notes),
    createdAt: parseTimestamp(row.created_at),
  };
}

export class ScamPatternCandidateStore {
  constructor(private readonly db: RuntimeDb) {}

  async insert(input: ScamPatternCandidateInsert): Promise<ScamPatternCandidate> {
    for (const pattern of input.patterns) {
      if (!VALID_SCAM_PATTERN_IDS.has(pattern)) {
        throw new Error(`[ScamPatternCandidates] invalid pattern id: ${pattern}`);
      }
    }

    const id = randomUUID();
    const sql = `INSERT INTO ${TABLE} (
        id, chain, address, patterns, evidence, has_known_label_match, label_matches
      ) VALUES (
        ${sqlText(id)},
        ${sqlText(input.chain)},
        ${sqlText(input.address)},
        ${sqlJson(input.patterns)},
        ${sqlJson(input.evidence)},
        ${sqlBoolean(input.hasKnownLabelMatch)},
        ${sqlJson(input.labelMatches)}
      ) RETURNING ${SELECT_COLUMNS}`;

    const rows = await executeRawSql(this.db, sql);
    if (rows.length === 0) {
      throw new Error("[ScamPatternCandidates] insert returned no rows");
    }
    return rowToCandidate(rows[0]);
  }

  async list(
    filter: ScamPatternCandidateListFilter,
  ): Promise<ReadonlyArray<ScamPatternCandidate>> {
    const where: string[] = [];
    if (filter.chain) {
      where.push(`chain = ${sqlText(filter.chain)}`);
    }
    if (filter.reviewStatus) {
      where.push(`review_status = ${sqlText(filter.reviewStatus)}`);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${sqlInteger(filter.limit)}`;

    const rows = await executeRawSql(this.db, sql);
    return rows.map(rowToCandidate);
  }

  async byId(id: string): Promise<ScamPatternCandidate | null> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE id = ${sqlText(id)} LIMIT 1`;
    const rows = await executeRawSql(this.db, sql);
    if (rows.length === 0) return null;
    return rowToCandidate(rows[0]);
  }

  async byAddress(
    chain: SupportedChain,
    address: string,
  ): Promise<ScamPatternCandidate | null> {
    const sql = `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
      WHERE chain = ${sqlText(chain)} AND address = ${sqlText(address)}
      LIMIT 1`;
    const rows = await executeRawSql(this.db, sql);
    if (rows.length === 0) return null;
    return rowToCandidate(rows[0]);
  }

  async accept(
    id: string,
    resolution: ScamPatternCandidateResolution,
  ): Promise<ScamPatternCandidate> {
    return this.transition(id, "accepted", resolution);
  }

  async reject(
    id: string,
    resolution: ScamPatternCandidateResolution,
  ): Promise<ScamPatternCandidate> {
    return this.transition(id, "rejected", resolution);
  }

  private async transition(
    id: string,
    target: ReviewStatus,
    resolution: ScamPatternCandidateResolution,
  ): Promise<ScamPatternCandidate> {
    const current = await this.byId(id);
    if (!current) {
      throw new ScamPatternCandidateNotFoundError(id);
    }
    if (!ALLOWED_REVIEW_TRANSITIONS[current.reviewStatus].includes(target)) {
      throw new ReviewStateTransitionError(id, current.reviewStatus, target);
    }

    const sql = `UPDATE ${TABLE}
      SET review_status = ${sqlText(target)},
          reviewed_by = ${sqlText(resolution.reviewedBy)},
          reviewed_at = now(),
          review_notes = ${sqlText(resolution.reviewNotes)}
      WHERE id = ${sqlText(id)}
      RETURNING ${SELECT_COLUMNS}`;

    const rows = await executeRawSql(this.db, sql);
    if (rows.length === 0) {
      throw new ScamPatternCandidateNotFoundError(id);
    }
    return rowToCandidate(rows[0]);
  }
}
