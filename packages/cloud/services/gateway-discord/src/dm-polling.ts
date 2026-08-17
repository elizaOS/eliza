/** Polls tracked Discord bot DM channels when user-installed apps do not emit message events. */

export interface TrackedDiscordDm {
  channelId: string;
  userId: string;
  lastMessageId: string;
}

export interface DiscordDmPollMessage {
  id: string;
  author: { bot: boolean };
  content: string;
}

export interface DiscordDmPollReport {
  channels: number;
  messages: number;
  routed: number;
  deduplicated: number;
  removed: number;
}

const DEFAULT_CHANNEL_CONCURRENCY = 4;
const MAX_CHANNEL_CONCURRENCY = 16;

function compareSnowflakes(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reads every tracked channel once and advances its durable cursor in message
 * order. A per-message claim lets this safely overlap Discord Gateway delivery.
 */
export async function pollTrackedDiscordDms<
  T extends DiscordDmPollMessage,
>(options: {
  listTracked: () => Promise<TrackedDiscordDm[]>;
  fetchAfter: (state: TrackedDiscordDm) => Promise<T[]>;
  claimMessage: (messageId: string) => Promise<boolean>;
  routeMessage: (message: T) => Promise<void>;
  updateCursor: (state: TrackedDiscordDm, messageId: string) => Promise<void>;
  removeTracked: (state: TrackedDiscordDm) => Promise<void>;
  isTerminalChannelError: (error: unknown) => boolean;
  onError?: (state: TrackedDiscordDm, error: unknown) => void;
  /** Bounds parallel Discord REST reads while preserving order within a DM. */
  channelConcurrency?: number;
}): Promise<DiscordDmPollReport> {
  const report: DiscordDmPollReport = {
    channels: 0,
    messages: 0,
    routed: 0,
    deduplicated: 0,
    removed: 0,
  };

  const tracked = await options.listTracked();
  report.channels = tracked.length;
  const requestedConcurrency =
    options.channelConcurrency ?? DEFAULT_CHANNEL_CONCURRENCY;
  const finiteConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.floor(requestedConcurrency)
    : DEFAULT_CHANNEL_CONCURRENCY;
  const concurrency = Math.max(
    1,
    Math.min(MAX_CHANNEL_CONCURRENCY, finiteConcurrency),
  );
  let nextIndex = 0;
  const pollChannel = async (state: TrackedDiscordDm): Promise<void> => {
    let messages: T[];
    try {
      messages = await options.fetchAfter(state);
    } catch (error) {
      if (options.isTerminalChannelError(error)) {
        await options.removeTracked(state);
        report.removed += 1;
      } else {
        options.onError?.(state, error);
      }
      return;
    }

    messages.sort((left, right) => compareSnowflakes(left.id, right.id));
    for (const message of messages) {
      report.messages += 1;
      const content = message.content.trim();
      if (!message.author.bot && content) {
        if (await options.claimMessage(message.id)) {
          await options.routeMessage(message);
          report.routed += 1;
        } else {
          report.deduplicated += 1;
        }
      }
      await options.updateCursor(state, message.id);
      state.lastMessageId = message.id;
    }
  };
  const worker = async (): Promise<void> => {
    while (nextIndex < tracked.length) {
      const state = tracked[nextIndex++];
      if (state) await pollChannel(state);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tracked.length) }, () =>
      worker(),
    ),
  );
  return report;
}
