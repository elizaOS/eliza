import { type Profile, parseProfile } from './profile';
import type { QueryProfilesResponse } from './timeline-v1';
import type { TimelineUserResultRaw } from './timeline-v2';

export interface RelationshipEntryItemContentRaw {
  itemType?: string;
  userDisplayType?: string;
  user_results?: {
    result?: TimelineUserResultRaw;
  };
}

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

export function parseRelationshipTimeline(
  timeline: RelationshipTimeline,
): QueryProfilesResponse {
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;
  const profiles: Profile[] = [];
  const instructions =
    timeline.data?.user?.result?.timeline?.timeline?.instructions ?? [];

  for (const instruction of instructions) {
    if (
      instruction.type === 'TimelineAddEntries' ||
      instruction.type === 'TimelineReplaceEntry'
    ) {
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
            const profile = parseProfile(
              userResultRaw.legacy,
              userResultRaw.is_blue_verified,
            );

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
