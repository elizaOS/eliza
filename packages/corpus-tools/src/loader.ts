/**
 * Read-side corpus loader for downstream mock and scenario consumers. It walks
 * a shard tree with the shared validator, then applies a caller-declared
 * selection (platform, account, thread, time window, message cap) with a
 * deterministic ts-then-id ordering so repeated loads seed identical mocks.
 *
 * The loader is the enforcement point for the corpus program's scrub floor:
 * by default only `verified` rows are released, and any validation issue in a
 * selected shard aborts the load instead of serving a partially clean corpus.
 * Because the floor is a release gate over personal data, the selection is
 * validated at this boundary rather than trusted from the type system.
 *
 * It is also the single identity domain for a corpus: `readCorpusShard` scopes
 * duplicate-id detection and reply resolution to one shard, so this module
 * re-derives both across every collected row.
 */
import type { CorpusMessage, CorpusPlatform, ScrubState } from "./schema.ts";
import { scrubStateRank, scrubStates } from "./schema.ts";
import {
  type CorpusValidationIssue,
  findCorpusShardFiles,
  readCorpusShard,
} from "./validator.ts";

export interface CorpusLoadSelection {
  platforms?: readonly CorpusPlatform[];
  accountIds?: readonly string[];
  threadIds?: readonly string[];
  /** Inclusive lower bound on message ts (epoch ms). */
  fromTs?: number;
  /** Inclusive upper bound on message ts (epoch ms). */
  toTs?: number;
  /** Cap applied after filtering and deterministic ordering. */
  maxMessages?: number;
  /**
   * Minimum scrub state a row must have reached to be released. Defaults to
   * `verified`; loosen only in tests that exercise the pipeline itself.
   */
  minScrubState?: ScrubState;
}

export interface CorpusLoadResult {
  messages: CorpusMessage[];
  /** Rows read from disk before selection filtering. */
  scanned: number;
  /** Rows excluded solely because they had not reached `minScrubState`. */
  belowScrubFloor: number;
  shardCount: number;
  byPlatform: Partial<Record<CorpusPlatform, number>>;
}

export class CorpusLoadError extends Error {
  readonly issues: readonly CorpusValidationIssue[];

  constructor(rootDir: string, issues: readonly CorpusValidationIssue[]) {
    const preview = issues
      .slice(0, 3)
      .map((issue) => `${issue.path ?? "<corpus>"}: ${issue.message}`)
      .join("; ");
    super(
      `corpus load from ${rootDir} failed with ${issues.length} validation issue(s): ${preview}`,
    );
    this.name = "CorpusLoadError";
    this.issues = issues;
  }
}

/**
 * Raised when a caller's selection is not a usable shape. The scrub floor is a
 * release gate over personal data, so an unrecognized `minScrubState` — from
 * decoded configuration, a cast, or plain JavaScript — must abort the load
 * rather than silently comparing against `undefined` and releasing every row.
 */
export class CorpusSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusSelectionError";
  }
}

function assertFiniteInteger(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new CorpusSelectionError(
      `corpus selection ${field} must be a finite integer, received ${String(value)}`,
    );
  }
}

/**
 * Validates the caller-supplied selection at the public boundary. TypeScript
 * does not survive a decoded JSON config or a cast, and every field here gates
 * either what is released or how much of it is.
 */
function validateSelection(selection: CorpusLoadSelection): ScrubState {
  const requested = selection.minScrubState ?? "verified";
  if (!scrubStates.includes(requested as ScrubState)) {
    throw new CorpusSelectionError(
      `corpus selection minScrubState must be one of ${scrubStates.join(", ")}, received ${JSON.stringify(requested)}`,
    );
  }
  assertFiniteInteger(selection.fromTs, "fromTs");
  assertFiniteInteger(selection.toTs, "toTs");
  assertFiniteInteger(selection.maxMessages, "maxMessages");
  if (
    selection.fromTs !== undefined &&
    selection.toTs !== undefined &&
    selection.fromTs > selection.toTs
  ) {
    throw new CorpusSelectionError(
      `corpus selection window is inverted: fromTs ${selection.fromTs} > toTs ${selection.toTs}`,
    );
  }
  if (selection.maxMessages !== undefined && selection.maxMessages < 0) {
    throw new CorpusSelectionError(
      `corpus selection maxMessages must not be negative, received ${selection.maxMessages}`,
    );
  }
  return requested as ScrubState;
}

/**
 * Recomputes the identity and relationship checks over the WHOLE corpus.
 * `readCorpusShard` scopes its duplicate-id set and reply resolution to one
 * shard, so two valid shards can carry the same message id (which would then
 * seed a consumer with order-dependent overwrites) and a reply whose parent
 * lives in an adjacent month shard is falsely reported missing. The loader is
 * the single identity domain, so it drops the per-shard verdicts for those two
 * codes and re-derives them across every collected row.
 */
function corpusWideIdentityIssues(
  rows: readonly CorpusMessage[],
): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];
  const ids = new Set<string>();
  for (const message of rows) {
    if (ids.has(message.id)) {
      issues.push({
        code: "duplicate-id",
        message: `duplicate message id ${message.id} across the selected corpus`,
      });
    }
    ids.add(message.id);
  }
  for (const message of rows) {
    if (message.replyToId && !ids.has(message.replyToId)) {
      issues.push({
        code: "reply-missing",
        message: `message ${message.id} replies to missing ${message.replyToId}`,
      });
    }
  }
  return issues;
}

function matchesSelection(
  message: CorpusMessage,
  selection: CorpusLoadSelection,
): boolean {
  if (selection.platforms && !selection.platforms.includes(message.platform)) {
    return false;
  }
  if (
    selection.accountIds &&
    !selection.accountIds.includes(message.accountId)
  ) {
    return false;
  }
  if (selection.threadIds && !selection.threadIds.includes(message.threadId)) {
    return false;
  }
  if (selection.fromTs !== undefined && message.ts < selection.fromTs) {
    return false;
  }
  if (selection.toTs !== undefined && message.ts > selection.toTs) {
    return false;
  }
  return true;
}

/**
 * Loads validated corpus messages from a shard tree rooted at `rootDir`
 * (`<platform>/<account>/<yyyy-mm>.jsonl`). Throws `CorpusLoadError` when any
 * shard fails validation — a corpus that cannot fully validate must never
 * partially seed a mock.
 */
export async function loadCorpusMessages(
  rootDir: string,
  selection: CorpusLoadSelection = {},
): Promise<CorpusLoadResult> {
  const minScrubState = validateSelection(selection);
  const minRank = scrubStateRank[minScrubState];
  const shardFiles = await findCorpusShardFiles(rootDir);

  const issues: CorpusValidationIssue[] = [];
  const rows: CorpusMessage[] = [];
  for (const file of shardFiles) {
    const shard = await readCorpusShard(file, { rootDir });
    // Identity and reply resolution are corpus-wide concerns, re-derived below.
    issues.push(
      ...shard.issues.filter(
        (issue) =>
          issue.code !== "duplicate-id" && issue.code !== "reply-missing",
      ),
    );
    rows.push(...shard.messages);
  }
  issues.push(...corpusWideIdentityIssues(rows));
  if (issues.length > 0) {
    throw new CorpusLoadError(rootDir, issues);
  }

  let belowScrubFloor = 0;
  const selected = rows.filter((message) => {
    if (!matchesSelection(message, selection)) return false;
    if (scrubStateRank[message.scrubState] < minRank) {
      belowScrubFloor += 1;
      return false;
    }
    return true;
  });

  selected.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const messages =
    selection.maxMessages !== undefined
      ? selected.slice(0, selection.maxMessages)
      : selected;

  const byPlatform: Partial<Record<CorpusPlatform, number>> = {};
  for (const message of messages) {
    byPlatform[message.platform] = (byPlatform[message.platform] ?? 0) + 1;
  }

  return {
    messages,
    scanned: rows.length,
    belowScrubFloor,
    shardCount: shardFiles.length,
    byPlatform,
  };
}
