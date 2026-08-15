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
  for (const state of tracked) {
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
      continue;
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
  }
  return report;
}
