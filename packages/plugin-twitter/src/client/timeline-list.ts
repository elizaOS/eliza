import type { QueryTweetsResponse } from './timeline-v1';
import { type TimelineEntryRaw, parseAndPush } from './timeline-v2';
import type { Tweet } from './tweets';

/**
 * Interface representing a list timeline with optional data.
 *
 * @property {Object} data - Optional object containing list timeline data.
 * @property {Object} data.list - Optional object containing list information.
 * @property {Object} data.list.tweets_timeline - Optional object containing tweets timeline information.
 * @property {Object} data.list.tweets_timeline.timeline - Optional object containing timeline instructions.
 * @property {Object[]} data.list.tweets_timeline.timeline.instructions - Optional array of timeline instructions.
 * @property {Object[]} data.list.tweets_timeline.timeline.instructions.entries - Optional array of timeline entry objects.
 * @property {Object} data.list.tweets_timeline.timeline.instructions.entry - Optional single timeline entry object.
 * @property {string} data.list.tweets_timeline.timeline.instructions.type - Optional string indicating the type of timeline entry.
 */

export interface ListTimeline {
  data?: {
    list?: {
      tweets_timeline?: {
        timeline?: {
          instructions?: {
            entries?: TimelineEntryRaw[];
            entry?: TimelineEntryRaw;
            type?: string;
          }[];
        };
      };
    };
  };
}

/**
 * Parses the list timeline tweets from the provided ListTimeline object.
 *
 * @param {ListTimeline} timeline The ListTimeline object to parse tweets from.
 * @returns {QueryTweetsResponse} An object containing the parsed tweets, next cursor, and previous cursor.
 */
export function parseListTimelineTweets(timeline: ListTimeline): QueryTweetsResponse {
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;
  const tweets: Tweet[] = [];
  const instructions = timeline.data?.list?.tweets_timeline?.timeline?.instructions ?? [];
  for (const instruction of instructions) {
    const entries = instruction.entries ?? [];

    for (const entry of entries) {
      const entryContent = entry.content;
      if (!entryContent) continue;

      if (entryContent.cursorType === 'Bottom') {
        bottomCursor = entryContent.value;
        continue;
      }
      if (entryContent.cursorType === 'Top') {
        topCursor = entryContent.value;
        continue;
      }

      const idStr = entry.entryId;
      if (!idStr.startsWith('tweet') && !idStr.startsWith('list-conversation')) {
        continue;
      }

      if (entryContent.itemContent) {
        parseAndPush(tweets, entryContent.itemContent, idStr);
      } else if (entryContent.items) {
        for (const contentItem of entryContent.items) {
          if (contentItem.item?.itemContent && contentItem.entryId) {
            parseAndPush(
              tweets,
              contentItem.item.itemContent,
              contentItem.entryId.split('tweet-')[1]
            );
          }
        }
      }
    }
  }

  return { tweets, next: bottomCursor, previous: topCursor };
}
