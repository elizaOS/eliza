import { type LegacyUserRaw, type Profile, parseProfile } from './profile';
import { parseMediaGroups, reconstructTweetHtml } from './timeline-tweet-util';
import type { PlaceRaw, Tweet } from './tweets';
import { isFieldDefined } from './type-util';

/**
 * Interface representing a hashtag.
 * @property {string} [text] - The text of the hashtag.
 */
export interface Hashtag {
  text?: string;
}

/**
 * Represents the basic raw data for a user mention in a timeline.
 * @interface
 * @property {string} [id_str] - The ID of the user in string format.
 * @property {string} [name] - The name of the user.
 * @property {string} [screen_name] - The screen name of the user.
 */
export interface TimelineUserMentionBasicRaw {
  id_str?: string;
  name?: string;
  screen_name?: string;
}

/**
 * Interface representing basic raw data for timeline media.
 * @typedef {Object} TimelineMediaBasicRaw
 * @property {string} [media_url_https] - The HTTPS URL of the media.
 * @property {string} [type] - The type of media.
 * @property {string} [url] - The URL of the media.
 */
export interface TimelineMediaBasicRaw {
  media_url_https?: string;
  type?: string;
  url?: string;
}

/**
 * Interface representing a basic raw timeline URL.
 * @property {string} expanded_url - The expanded URL of the timeline URL.
 * @property {string} url - The original URL of the timeline URL.
 */
export interface TimelineUrlBasicRaw {
  expanded_url?: string;
  url?: string;
}

/**
 * Interface representing raw data for sensitive media warnings.
 * @property {boolean} [adult_content] - Indicates if the content contains adult material.
 * @property {boolean} [graphic_violence] - Indicates if the content contains graphic violence.
 * @property {boolean} [other] - Indicates if the content contains other sensitive material.
 */
export interface ExtSensitiveMediaWarningRaw {
  adult_content?: boolean;
  graphic_violence?: boolean;
  other?: boolean;
}

/**
 * Interface representing a video variant with optional properties.
 * @typedef {Object} VideoVariant
 * @property {number} [bitrate] - The bitrate of the video variant.
 * @property {string} [url] - The URL of the video variant.
 */
export interface VideoVariant {
  bitrate?: number;
  url?: string;
}

/**
 * Interface representing video information.
 * @property {VideoVariant[]} variants - Array of video variants.
 */
export interface VideoInfo {
  variants?: VideoVariant[];
}

/**
 * Interface representing an extended timeline media object in raw format.
 * @property {string} [id_str] - The unique identifier for the media.
 * @property {string} [media_url_https] - The HTTPS URL of the media.
 * @property {ExtSensitiveMediaWarningRaw} [ext_sensitive_media_warning] - The sensitive media warning information.
 * @property {string} [type] - The type of the media.
 * @property {string} [url] - The URL of the media.
 * @property {VideoInfo} [video_info] - Information about the video.
 * @property {string | undefined} ext_alt_text - The alternative text for the media.
 */
export interface TimelineMediaExtendedRaw {
  id_str?: string;
  media_url_https?: string;
  ext_sensitive_media_warning?: ExtSensitiveMediaWarningRaw;
  type?: string;
  url?: string;
  video_info?: VideoInfo;
  ext_alt_text: string | undefined;
}

/**
 * Interface representing the raw search result data.
 * @property {string} rest_id - The unique ID of the search result.
 * @property {string} __typename - The type name of the search result.
 * @property {Object} core - The core data of the search result.
 * @property {Object} core.user_results - The user results within the core data.
 * @property {Object} core.user_results.result - The user result details.
 * @property {boolean} core.user_results.result.is_blue_verified - Indicates if the user is blue verified.
 * @property {Object} core.user_results.result.legacy - The legacy user raw data.
 * @property {Object} views - The views data of the search result.
 * @property {string} views.count - The count of views for the search result.
 * @property {Object} note_tweet - The note tweet data of the search result.
 * @property {Object} note_tweet.note_tweet_results - The note tweet results within the note tweet data.
 * @property {Object} note_tweet.note_tweet_results.result - The note tweet result details.
 * @property {string} note_tweet.note_tweet_results.result.text - The text content of the note tweet result.
 * @property {Object} quoted_status_result - The quoted status result data of the search result.
 * @property {Object} quoted_status_result.result - The search result data of the quoted status.
 * @property {SearchResultRaw} quoted_status_result.result - The raw search result data of the quoted status.
 * @property {Object} legacy - The legacy tweet raw data of the search result.
 */
export interface SearchResultRaw {
  rest_id?: string;
  __typename?: string;
  core?: {
    user_results?: {
      result?: {
        is_blue_verified?: boolean;
        legacy?: LegacyUserRaw;
      };
    };
  };
  views?: {
    count?: string;
  };
  note_tweet?: {
    note_tweet_results?: {
      result?: {
        text?: string;
      };
    };
  };
  quoted_status_result?: {
    result?: SearchResultRaw;
  };
  legacy?: LegacyTweetRaw;
}

/**
 * Interface representing the raw data structure for a timeline article result.
 * @typedef { Object } TimelineArticleResultRaw
 * @property { string } [id] - The ID of the article.
 * @property { string } [rest_id] - The rest ID of the article.
 * @property { string } [title] - The title of the article.
 * @property { string } [preview_text] - The preview text of the article.
 * @property { Object } cover_media - The cover media of the article.
 * @property { string } [cover_media.media_id] - The ID of the cover media.
 * @property { Object } [cover_media.media_info] - Additional information about the cover media.
 * @property { string } [cover_media.media_info.original_img_url] - The URL of the original image.
 * @property { number } [cover_media.media_info.original_img_height] - The height of the original image.
 * @property { number } [cover_media.media_info.original_img_width] - The width of the original image.
 * @property { Object } content_state - The content state of the article.
 * @property {Object[]} [content_state.blocks] - An array of blocks within the content state.
 * @property { string } [content_state.blocks.key] - The key of the block.
 * @property { string } [content_state.blocks.data] - The data of the block.
 * @property { string } [content_state.blocks.text] - The text of the block.
 * @property {Object[]} [content_state.blocks.entityRanges] - An array of entity ranges within the block.
 * @property { number } [content_state.blocks.entityRanges.key] - The key of the entity range.
 * @property { number } [content_state.blocks.entityRanges.length] - The length of the entity range.
 * @property { number } [content_state.blocks.entityRanges.offset] - The offset of the entity range.
 * @property {Object[]} entityMap - An array of entity mappings within the article.
 * @property { string } [entityMap.key] - The key of the entity mapping.
 * @property { Object } entityMap.value - The value of the entity mapping.
 * @property { string } [entityMap.value.type] - The type of the entity mapping (LINK, MEDIA, TWEET).
 * @property { string } [entityMap.value.mutability] - The mutability of the entity mapping.
 * @property { Object } [entityMap.value.data] - Additional data within the entity mapping.
 * @property { string } [entityMap.value.data.entityKey] - The key of the entity data.
 * @property { string } [entityMap.value.data.url] - The URL within the entity data.
 * @property { string } [entityMap.value.data.tweetId] - The tweet ID within the entity data.
 * @property {Object[]} [entityMap.value.data.mediaItems] - An array of media items within the entity data.
 * @property { string } [entityMap.value.data.mediaItems.localMediaId] - The local media ID within the media items.
 * @property { string } [entityMap.value.data.mediaItems.mediaCategory] - The media category within the media items.
 * @property { string } [entityMap.value.data.mediaItems.mediaId] - The media ID within the media items.
 */
export interface TimelineArticleResultRaw {
  id?: string;
  rest_id?: string;
  title?: string;
  preview_text?: string;
  cover_media?: {
    media_id?: string;
    media_info?: {
      original_img_url?: string;
      original_img_height?: number;
      original_img_width?: number;
    };
  };
  content_state?: {
    blocks?: {
      key?: string;
      data?: string;
      text?: string;
      entityRanges?: {
        key?: number;
        length?: number;
        offset?: number;
      }[];
    }[];
  };
  entityMap?: {
    key?: string;
    value?: {
      type?: string; // LINK, MEDIA, TWEET
      mutability?: string;
      data?: {
        entityKey?: string;
        url?: string;
        tweetId?: string;
        mediaItems?: {
          localMediaId?: string;
          mediaCategory?: string;
          mediaId?: string;
        }[];
      };
    };
  }[];
}

/**
 * Interface representing the raw data structure of a timeline result.
 * @typedef {Object} TimelineResultRaw
 * @property {string} [rest_id] - The restaurant ID.
 * @property {string} [__typename] - The type name.
 * @property {Object} core - The core data.
 * @property {Object} core.user_results - The user results data.
 * @property {Object} core.user_results.result - The result data.
 * @property {boolean} core.user_results.result.is_blue_verified - Indicates if the user is blue verified.
 * @property {Object} core.user_results.result.legacy - The legacy user data.
 * @property {Object} views - The views data.
 * @property {string} views.count - The count of views.
 * @property {Object} note_tweet - The note tweet data.
 * @property {Object} note_tweet.note_tweet_results - The note tweet results data.
 * @property {Object} note_tweet.note_tweet_results.result - The result data of the note tweet.
 * @property {string} note_tweet.note_tweet_results.result.text - The text of the note tweet.
 * @property {Object} article - The article data.
 * @property {Object} article.article_results - The article results data.
 * @property {Object} article.article_results.result - The result data of the article.
 * @property {Object} quoted_status_result - The quoted status result data.
 * @property {Object} quoted_status_result.result - The result data of the quoted status.
 * @property {Object} legacy - The legacy tweet data.
 * @property {Object} tweet - The tweet data.
 */
export interface TimelineResultRaw {
  rest_id?: string;
  __typename?: string;
  core?: {
    user_results?: {
      result?: {
        is_blue_verified?: boolean;
        legacy?: LegacyUserRaw;
      };
    };
  };
  views?: {
    count?: string;
  };
  note_tweet?: {
    note_tweet_results?: {
      result?: {
        text?: string;
      };
    };
  };
  article?: {
    article_results?: {
      result?: TimelineArticleResultRaw;
    };
  };
  quoted_status_result?: {
    result?: TimelineResultRaw;
  };
  legacy?: LegacyTweetRaw;
  tweet?: TimelineResultRaw;
}

/**
 * Interface representing a raw legacy tweet object.
 * @typedef { Object } LegacyTweetRaw
 * @property { number } [bookmark_count] - The number of bookmarks for the tweet.
 * @property { string } [conversation_id_str] - The ID of the conversation the tweet belongs to.
 * @property { string } [created_at] - The timestamp when the tweet was created.
 * @property { number } [favorite_count] - The number of favorites for the tweet.
 * @property { string } [full_text] - The full text content of the tweet.
 * @property { Object } [entities] - The entities in the tweet, such as hashtags, media, URLs, and user mentions.
 * @property {Array<Hashtag>} [entities.hashtags] - An array of hashtags used in the tweet.
 * @property {Array<TimelineMediaBasicRaw>} [entities.media] - An array of basic media objects included in the tweet.
 * @property {Array<TimelineUrlBasicRaw>} [entities.urls] - An array of URL objects included in the tweet.
 * @property {Array<TimelineUserMentionBasicRaw>} [entities.user_mentions] - An array of user mentions included in the tweet.
 * @property { Object } [extended_entities] - Extended entities in the tweet, such as media.
 * @property {Array<TimelineMediaExtendedRaw>} [extended_entities.media] - An array of extended media objects included in the tweet.
 * @property { string } [id_str] - The ID of the tweet as a string.
 * @property { string } [in_reply_to_status_id_str] - The ID of the tweet this tweet is replying to, as a string.
 * @property { PlaceRaw } [place] - The place associated with the tweet.
 * @property { number } [reply_count] - The number of replies to the tweet.
 * @property { number } [retweet_count] - The number of retweets for the tweet.
 * @property { string } [retweeted_status_id_str] - The ID of the retweeted status, as a string.
 * @property { Object } [retweeted_status_result] - The result of the retweeted status.
 * @property { TimelineResultRaw } [retweeted_status_result.result] - The result of the retweeted status.
 * @property { string } [quoted_status_id_str] - The ID of the quoted status, as a string.
 * @property { string } [time] - The timestamp of the tweet.
 * @property { string } [user_id_str] - The ID of the user who posted the tweet, as a string.
 * @property { Object } [ext_views] - Additional views information for the tweet.
 * @property { string } [ext_views.state] - The state of the additional views.
 * @property { string } [ext_views.count] - The count of the additional views.
 */
export interface LegacyTweetRaw {
  bookmark_count?: number;
  conversation_id_str?: string;
  created_at?: string;
  favorite_count?: number;
  full_text?: string;
  entities?: {
    hashtags?: Hashtag[];
    media?: TimelineMediaBasicRaw[];
    urls?: TimelineUrlBasicRaw[];
    user_mentions?: TimelineUserMentionBasicRaw[];
  };
  extended_entities?: {
    media?: TimelineMediaExtendedRaw[];
  };
  id_str?: string;
  in_reply_to_status_id_str?: string;
  place?: PlaceRaw;
  reply_count?: number;
  retweet_count?: number;
  retweeted_status_id_str?: string;
  retweeted_status_result?: {
    result?: TimelineResultRaw;
  };
  quoted_status_id_str?: string;
  time?: string;
  user_id_str?: string;
  ext_views?: {
    state?: string;
    count?: string;
  };
}

/**
 * Interface representing global objects in a timeline.
 * @typedef {object} TimelineGlobalObjectsRaw
 * @property {object} tweets - A key-value pair where the key is a string and the value is either a LegacyTweetRaw object or undefined.
 * @property {object} users - A key-value pair where the key is a string and the value is either a LegacyUserRaw object or undefined.
 */
export interface TimelineGlobalObjectsRaw {
  tweets?: { [key: string]: LegacyTweetRaw | undefined };
  users?: { [key: string]: LegacyUserRaw | undefined };
}

/**
 * Interface representing a raw cursor in timeline data.
 * @typedef {Object} TimelineDataRawCursor
 * @property {string} [value] - The value of the cursor.
 * @property {string} [cursorType] - The type of cursor.
 */
export interface TimelineDataRawCursor {
  value?: string;
  cursorType?: string;
}

/**
 * Interface representing the raw data of a timeline entity.
 * @typedef {object} TimelineDataRawEntity
 * @property {string} [id] - The unique identifier of the entity.
 */
export interface TimelineDataRawEntity {
  id?: string;
}

/**
 * Interface representing raw module item data for the timeline.
 * @property {object} clientEventInfo - Information about the client event.
 * @property {object} clientEventInfo.details - Details of the client event.
 * @property {object} clientEventInfo.details.guideDetails - Details about the guide.
 * @property {object} clientEventInfo.details.guideDetails.transparentGuideDetails - Details about the transparent guide.
 * @property {object} clientEventInfo.details.guideDetails.transparentGuideDetails.trendMetadata - Metadata about the trend.
 * @property {string} clientEventInfo.details.guideDetails.transparentGuideDetails.trendMetadata.trendName - Name of the trend.
 */
export interface TimelineDataRawModuleItem {
  clientEventInfo?: {
    details?: {
      guideDetails?: {
        transparentGuideDetails?: {
          trendMetadata?: {
            trendName?: string;
          };
        };
      };
    };
  };
}

/**
 * Interface representing raw data for adding an entry to a timeline.
 * @typedef {Object} TimelineDataRawAddEntry
 * @property {Object} content - The content of the entry.
 * @property {Object} content.item - The item within the content.
 * @property {Object} content.item.content - The content of the item.
 * @property {TimelineDataRawEntity} content.item.content.tweet - The tweet entity within the item.
 * @property {TimelineDataRawEntity} content.item.content.user - The user entity within the item.
 * @property {Object} content.operation - The operation within the content.
 * @property {TimelineDataRawCursor} content.operation.cursor - The cursor within the operation.
 * @property {Object} content.timelineModule - The timeline module within the content.
 * @property {Array} content.timelineModule.items - The items within the timeline module.
 * @property {TimelineDataRawModuleItem} content.timelineModule.items.item - The module item within the items.
 */
export interface TimelineDataRawAddEntry {
  content?: {
    item?: {
      content?: {
        tweet?: TimelineDataRawEntity;
        user?: TimelineDataRawEntity;
      };
    };
    operation?: {
      cursor?: TimelineDataRawCursor;
    };
    timelineModule?: {
      items?: {
        item?: TimelineDataRawModuleItem;
      }[];
    };
  };
}

/**
 * Represents the raw data structure for a pin entry in the timeline.
 * @typedef {object} TimelineDataRawPinEntry
 * @property {object} content - The content of the pin entry.
 * @property {object} content.item - The item within the content.
 * @property {object} content.item.content - The content within the item.
 * @property {TimelineDataRawEntity} content.item.content.tweet - The tweet entity within the content.
 */
export interface TimelineDataRawPinEntry {
  content?: {
    item?: {
      content?: {
        tweet?: TimelineDataRawEntity;
      };
    };
  };
}

/**
 * Interface for a raw replace entry in the timeline data.
 * @interface
 */

export interface TimelineDataRawReplaceEntry {
  content?: {
    operation?: {
      cursor?: TimelineDataRawCursor;
    };
  };
}

/**
 * Interface representing raw instructions for modifying timeline data.
 * @property {Object} addEntries - Object containing entries to add to the timeline.
 * @property {Object[]} addEntries.entries - Array of entries to add to the timeline.
 * @property {Object} pinEntry - Object containing entry to pin to the timeline.
 * @property {Object} pinEntry.entry - Entry to pin to the timeline.
 * @property {Object} replaceEntry - Object containing entry to replace on the timeline.
 * @property {Object} replaceEntry.entry - Entry to replace on the timeline.
 */
export interface TimelineDataRawInstruction {
  addEntries?: {
    entries?: TimelineDataRawAddEntry[];
  };
  pinEntry?: {
    entry?: TimelineDataRawPinEntry;
  };
  replaceEntry?: {
    entry?: TimelineDataRawReplaceEntry;
  };
}

/**
 * Interface representing raw timeline data.
 * @typedef {Object} TimelineDataRaw
 * @property {Array<TimelineDataRawInstruction>} [instructions] - Array of raw instructions.
 */
export interface TimelineDataRaw {
  instructions?: TimelineDataRawInstruction[];
}

/**
 * Interface representing a TimelineV1 object.
 * @property {TimelineGlobalObjectsRaw} [globalObjects] - The global objects associated with the timeline.
 * @property {TimelineDataRaw} [timeline] - The raw timeline data.
 */
export interface TimelineV1 {
  globalObjects?: TimelineGlobalObjectsRaw;
  timeline?: TimelineDataRaw;
}

/**
 * Type representing the result of parsing a tweet.
 * @typedef {Object} ParseTweetResult
 * @property {boolean} success - Indicates if the parse was successful.
 * @property {Tweet} tweet - The parsed tweet if successful.
 * @property {Error} err - The error object if the parse was unsuccessful.
 */
export type ParseTweetResult = { success: true; tweet: Tweet } | { success: false; err: Error };

/**
 * Parses a tweet from a timeline object and constructs a Tweet object with relevant information.
 *
 * @param {TimelineV1} timeline - The timeline object containing tweet and user data.
 * @param {string} id - The ID of the tweet to parse.
 * @returns {ParseTweetResult} An object indicating the success of parsing and the resulting Tweet object.
 */
function parseTimelineTweet(timeline: TimelineV1, id: string): ParseTweetResult {
  const tweets = timeline.globalObjects?.tweets ?? {};
  const tweet = tweets[id];
  if (tweet?.user_id_str == null) {
    return {
      success: false,
      err: new Error(`Tweet "${id}" was not found in the timeline object.`),
    };
  }

  const users = timeline.globalObjects?.users ?? {};
  const user = users[tweet.user_id_str];
  if (user?.screen_name == null) {
    return {
      success: false,
      err: new Error(`User "${tweet.user_id_str}" has no username data.`),
    };
  }

  const hashtags = tweet.entities?.hashtags ?? [];
  const mentions = tweet.entities?.user_mentions ?? [];
  const media = tweet.extended_entities?.media ?? [];
  const pinnedTweets = new Set<string | undefined>(user.pinned_tweet_ids_str ?? []);
  const urls = tweet.entities?.urls ?? [];
  const { photos, videos, sensitiveContent } = parseMediaGroups(media);

  const tw: Tweet = {
    conversationId: tweet.conversation_id_str,
    id,
    hashtags: hashtags.filter(isFieldDefined('text')).map((hashtag) => hashtag.text),
    likes: tweet.favorite_count,
    mentions: mentions.filter(isFieldDefined('id_str')).map((mention) => ({
      id: mention.id_str,
      username: mention.screen_name,
      name: mention.name,
    })),
    name: user.name,
    permanentUrl: `https://twitter.com/${user.screen_name}/status/${id}`,
    photos,
    replies: tweet.reply_count,
    retweets: tweet.retweet_count,
    text: tweet.full_text,
    thread: [],
    urls: urls.filter(isFieldDefined('expanded_url')).map((url) => url.expanded_url),
    userId: tweet.user_id_str,
    username: user.screen_name,
    videos,
  };

  if (tweet.created_at) {
    tw.timeParsed = new Date(Date.parse(tweet.created_at));
    tw.timestamp = Math.floor(tw.timeParsed.valueOf() / 1000);
  }

  if (tweet.place?.id) {
    tw.place = tweet.place;
  }

  if (tweet.quoted_status_id_str) {
    tw.isQuoted = true;
    tw.quotedStatusId = tweet.quoted_status_id_str;

    const quotedStatusResult = parseTimelineTweet(timeline, tweet.quoted_status_id_str);
    if (quotedStatusResult.success) {
      tw.quotedStatus = quotedStatusResult.tweet;
    }
  }

  if (tweet.in_reply_to_status_id_str) {
    tw.isReply = true;
    tw.inReplyToStatusId = tweet.in_reply_to_status_id_str;

    const replyStatusResult = parseTimelineTweet(timeline, tweet.in_reply_to_status_id_str);
    if (replyStatusResult.success) {
      tw.inReplyToStatus = replyStatusResult.tweet;
    }
  }

  if (tweet.retweeted_status_id_str != null) {
    tw.isRetweet = true;
    tw.retweetedStatusId = tweet.retweeted_status_id_str;

    const retweetedStatusResult = parseTimelineTweet(timeline, tweet.retweeted_status_id_str);
    if (retweetedStatusResult.success) {
      tw.retweetedStatus = retweetedStatusResult.tweet;
    }
  }

  const views = Number.parseInt(tweet.ext_views?.count ?? '');
  if (!Number.isNaN(views)) {
    tw.views = views;
  }

  if (pinnedTweets.has(tweet.id_str)) {
    // TODO: Update tests so this can be assigned at the tweet declaration
    tw.isPin = true;
  }

  if (sensitiveContent) {
    // TODO: Update tests so this can be assigned at the tweet declaration
    tw.sensitiveContent = true;
  }

  tw.html = reconstructTweetHtml(tweet, tw.photos, tw.videos);

  return { success: true, tweet: tw };
}

/**
 * A paginated tweets API response. The `next` field can be used to fetch the next page of results,
 * and the `previous` can be used to fetch the previous results (or results created after the
 * initial request)
 */
/**
 * Interface representing the response from a query tweets request.
 * @typedef {Object} QueryTweetsResponse
 * @property {Tweet[]} tweets - An array of Tweet objects.
 * @property {string} [next] - Optional. The token for fetching the next page of tweets.
 * @property {string} [previous] - Optional. The token for fetching the previous page of tweets.
 */
export interface QueryTweetsResponse {
  tweets: Tweet[];
  next?: string;
  previous?: string;
}

export function parseTimelineTweetsV1(timeline: TimelineV1): QueryTweetsResponse {
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;
  let pinnedTweet: Tweet | undefined;
  let orderedTweets: Tweet[] = [];
  for (const instruction of timeline.timeline?.instructions ?? []) {
    const { pinEntry, addEntries, replaceEntry } = instruction;

    // Handle pin instruction
    const pinnedTweetId = pinEntry?.entry?.content?.item?.content?.tweet?.id;
    if (pinnedTweetId != null) {
      const tweetResult = parseTimelineTweet(timeline, pinnedTweetId);
      if (tweetResult.success) {
        pinnedTweet = tweetResult.tweet;
      }
    }

    // Handle add instructions
    for (const { content } of addEntries?.entries ?? []) {
      const tweetId = content?.item?.content?.tweet?.id;
      if (tweetId != null) {
        const tweetResult = parseTimelineTweet(timeline, tweetId);
        if (tweetResult.success) {
          orderedTweets.push(tweetResult.tweet);
        }
      }

      const operation = content?.operation;
      if (operation?.cursor?.cursorType === 'Bottom') {
        bottomCursor = operation?.cursor?.value;
      } else if (operation?.cursor?.cursorType === 'Top') {
        topCursor = operation?.cursor?.value;
      }
    }

    // Handle replace instruction
    const operation = replaceEntry?.entry?.content?.operation;
    if (operation?.cursor?.cursorType === 'Bottom') {
      bottomCursor = operation.cursor.value;
    } else if (operation?.cursor?.cursorType === 'Top') {
      topCursor = operation.cursor.value;
    }
  }

  if (pinnedTweet != null && orderedTweets.length > 0) {
    orderedTweets = [pinnedTweet, ...orderedTweets];
  }

  return {
    tweets: orderedTweets,
    next: bottomCursor,
    previous: topCursor,
  };
}

/**
 * A paginated profiles API response. The `next` field can be used to fetch the next page of results.
 */
export interface QueryProfilesResponse {
  profiles: Profile[];
  next?: string;
  previous?: string;
}

export function parseUsers(timeline: TimelineV1): QueryProfilesResponse {
  const users = new Map<string | undefined, Profile>();

  const userObjects = timeline.globalObjects?.users ?? {};
  for (const id in userObjects) {
    const legacy = userObjects[id];
    if (legacy == null) {
      continue;
    }

    const user = parseProfile(legacy);
    users.set(id, user);
  }

  let bottomCursor: string | undefined;
  let topCursor: string | undefined;
  const orderedProfiles: Profile[] = [];
  for (const instruction of timeline.timeline?.instructions ?? []) {
    for (const entry of instruction.addEntries?.entries ?? []) {
      const userId = entry.content?.item?.content?.user?.id;
      const profile = users.get(userId);
      if (profile != null) {
        orderedProfiles.push(profile);
      }

      const operation = entry.content?.operation;
      if (operation?.cursor?.cursorType === 'Bottom') {
        bottomCursor = operation?.cursor?.value;
      } else if (operation?.cursor?.cursorType === 'Top') {
        topCursor = operation?.cursor?.value;
      }
    }

    const operation = instruction.replaceEntry?.entry?.content?.operation;
    if (operation?.cursor?.cursorType === 'Bottom') {
      bottomCursor = operation.cursor.value;
    } else if (operation?.cursor?.cursorType === 'Top') {
      topCursor = operation.cursor.value;
    }
  }

  return {
    profiles: orderedProfiles,
    next: bottomCursor,
    previous: topCursor,
  };
}
