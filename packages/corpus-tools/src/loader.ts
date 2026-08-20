/**
 * Read-side corpus loader for downstream mock and scenario consumers. It walks
 * a shard tree with the shared validator, then applies a caller-declared
 * selection (platform, account, thread, time window, message cap) with a
 * deterministic ts-then-id ordering so repeated loads seed identical mocks.
 *
 * The loader is the enforcement point for the corpus program's scrub floor:
 * by default only `verified` rows are released, and any validation issue in a
 * selected shard aborts the load instead of serving a partially clean corpus.
 */
import type { CorpusMessage, CorpusPlatform, ScrubState } from "./schema.ts";
import { scrubStateRank } from "./schema.ts";
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
  const minScrubState = selection.minScrubState ?? "verified";
  const minRank = scrubStateRank[minScrubState];
  const shardFiles = await findCorpusShardFiles(rootDir);

  const issues: CorpusValidationIssue[] = [];
  const rows: CorpusMessage[] = [];
  for (const file of shardFiles) {
    const shard = await readCorpusShard(file, { rootDir });
    issues.push(...shard.issues);
    rows.push(...shard.messages);
  }
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
