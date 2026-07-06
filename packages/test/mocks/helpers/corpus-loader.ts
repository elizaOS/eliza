/**
 * Loads validated personal-corpus shards into mock-service fixture shapes. The
 * loader keeps raw corpus IO at the mock boundary and hands each provider plain
 * deterministic fixtures so existing in-memory mock state stays synchronous.
 */
import {
  type CorpusMessage,
  findCorpusShardFiles,
  type GmailFixtureMessage,
  readCorpusShard,
  toGmailFixtureMessage,
} from "@elizaos/corpus-tools";

export interface CorpusSelectionOptions {
  platforms?: readonly string[];
  accounts?: readonly string[];
  dateRange?: {
    startMs?: number;
    endMs?: number;
  };
  threadIds?: readonly string[];
  maxMessages?: number;
}

export interface CorpusMockOptions {
  dir: string;
  select?: CorpusSelectionOptions;
}

export interface LoadedCorpusMockFixtures {
  gmailFixtures: GmailFixtureMessage[];
  gmailFixtureSets: Record<string, readonly string[]>;
}

function selected(
  value: string,
  allowed: readonly string[] | undefined,
): boolean {
  return !allowed || allowed.length === 0 || allowed.includes(value);
}

function messageSelected(
  message: CorpusMessage,
  selection: CorpusSelectionOptions | undefined,
): boolean {
  if (!selection) return true;
  if (!selected(message.platform, selection.platforms)) return false;
  if (!selected(message.accountId, selection.accounts)) return false;
  if (!selected(message.threadId, selection.threadIds)) return false;
  if (
    selection.dateRange?.startMs !== undefined &&
    message.ts < selection.dateRange.startMs
  ) {
    return false;
  }
  if (
    selection.dateRange?.endMs !== undefined &&
    message.ts > selection.dateRange.endMs
  ) {
    return false;
  }
  return true;
}

function buildFixtureSets(
  fixtures: readonly GmailFixtureMessage[],
): Record<string, readonly string[]> {
  const allIds = fixtures.map((fixture) => fixture.id);
  const byThread = new Map<string, string[]>();
  for (const fixture of fixtures) {
    const threadIds = byThread.get(fixture.threadId) ?? [];
    threadIds.push(fixture.id);
    byThread.set(fixture.threadId, threadIds);
  }
  return {
    "corpus:all": allIds,
    ...Object.fromEntries(
      [...byThread.entries()].map(([threadId, ids]) => [
        `corpus:thread:${threadId}`,
        ids,
      ]),
    ),
  };
}

export async function loadCorpusMockFixtures(
  options: CorpusMockOptions,
): Promise<LoadedCorpusMockFixtures> {
  const files = await findCorpusShardFiles(options.dir);
  const messages: CorpusMessage[] = [];
  for (const file of files) {
    const shard = await readCorpusShard(file, { rootDir: options.dir });
    if (shard.issues.length > 0) {
      throw new Error(
        `Corpus shard ${file} failed validation: ${shard.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    messages.push(...shard.messages);
  }

  const selectedMessages = messages
    .filter((message) => messageSelected(message, options.select))
    .slice(0, options.select?.maxMessages);
  const gmailFixtures = selectedMessages
    .filter((message) => message.platform === "gmail")
    .map((message) => toGmailFixtureMessage(message));

  return {
    gmailFixtures,
    gmailFixtureSets: buildFixtureSets(gmailFixtures),
  };
}
