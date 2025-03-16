import { type Profile, parseProfile } from './profile';
import type { QueryProfilesResponse } from './timeline-v1';
import type { TimelineUserResultRaw } from './timeline-v2';

/**
 * Interface for raw content of a relationship entry item.
 * @typedef { Object } RelationshipEntryItemContentRaw
 * @property { string } [itemType] - The type of item.
 * @property { string } [userDisplayType] - The display type for the user.
 * @property { Object } [user_results] - The results of the user.
 * @property { Object } [user_results.result] - The raw data of the timeline user result.
 */
export interface RelationshipEntryItemContentRaw {
  itemType?: string;
  userDisplayType?: string;
  user_results?: {
    result?: TimelineUserResultRaw;
  };
}

/**
 * Interface representing a raw relationship entry.
 * @interface
 * @property {string} entryId - The unique identifier for the entry.
 * @property {string} sortIndex - The sorting index for the entry.
 * @property {Object} [content] - Additional content for the entry.
 * @property {string} [content.cursorType] - The type of cursor.
 * @property {string} [content.entryType] - The type of entry.
 * @property {string} [content.__typename] - The typename of the content.
 * @property {string} [content.value] - The value of the content.
 * @property {RelationshipEntryItemContentRaw} [content.itemContent] - The raw item content for the entry.
 */

export interface RelationshipEntryRaw {
  entryId: string;
  sortIndex: string;
  content?: {
    cursorType?: string;
    entryType?: string;
    __typename?: string;
    value?: string;
    itemContent?: RelationshipEntryItemContentRaw;
  };
}

/**
 * Interface representing a relationship timeline.
 * @property {object} data - Optional property containing user result timeline instructions.
 * @property {object} data.user - Optional property containing user information.
 * @property {object} data.user.result - Optional property containing result information.
 * @property {object} data.user.result.timeline - Optional property containing timeline instructions.
 * @property {object} data.user.result.timeline.timeline - Optional property containing timeline instructions.
 * @property {object[]} data.user.result.timeline.timeline.instructions - Optional array of relationship entries.
 * @property {object} data.user.result.timeline.timeline.instructions.entry - Optional relationship entry object.
 * @property {object[]} data.user.result.timeline.timeline.instructions.type - Optional string representing type of timeline instructions.
 */
export interface RelationshipTimeline {
  data?: {
    user?: {
      result?: {
        timeline?: {
          timeline?: {
            instructions?: {
              entries?: RelationshipEntryRaw[];
              entry?: RelationshipEntryRaw;
              type?: string;
            }[];
          };
        };
      };
    };
  };
}

/**
 * Parses the given RelationshipTimeline data to extract profiles and cursors.
 * @param timeline The RelationshipTimeline data to parse.
 * @returns The QueryProfilesResponse object containing profiles, next cursor, and previous cursor.
 */
export function parseRelationshipTimeline(timeline: RelationshipTimeline): QueryProfilesResponse {
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;
  const profiles: Profile[] = [];
  const instructions = timeline.data?.user?.result?.timeline?.timeline?.instructions ?? [];

  for (const instruction of instructions) {
    if (instruction.type === 'TimelineAddEntries' || instruction.type === 'TimelineReplaceEntry') {
      if (instruction.entry?.content?.cursorType === 'Bottom') {
        bottomCursor = instruction.entry.content.value;
        continue;
      }

      if (instruction.entry?.content?.cursorType === 'Top') {
        topCursor = instruction.entry.content.value;
        continue;
      }

      const entries = instruction.entries ?? [];
      for (const entry of entries) {
        const itemContent = entry.content?.itemContent;
        if (itemContent?.userDisplayType === 'User') {
          const userResultRaw = itemContent.user_results?.result;

          if (userResultRaw?.legacy) {
            const profile = parseProfile(userResultRaw.legacy, userResultRaw.is_blue_verified);

            if (!profile.userId) {
              profile.userId = userResultRaw.rest_id;
            }

            profiles.push(profile);
          }
        } else if (entry.content?.cursorType === 'Bottom') {
          bottomCursor = entry.content.value;
        } else if (entry.content?.cursorType === 'Top') {
          topCursor = entry.content.value;
        }
      }
    }
  }

  return { profiles, next: bottomCursor, previous: topCursor };
}
