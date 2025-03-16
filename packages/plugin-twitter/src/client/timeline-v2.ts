import type { LegacyUserRaw } from './profile';
import { parseMediaGroups, reconstructTweetHtml } from './timeline-tweet-util';
import type {
  LegacyTweetRaw,
  ParseTweetResult,
  QueryTweetsResponse,
  SearchResultRaw,
  TimelineResultRaw,
} from './timeline-v1';
import type { Tweet } from './tweets';
import { isFieldDefined } from './type-util';

/**
 * Interface representing raw data for a user result in a timeline.
 * @property {string} [rest_id] - The REST ID of the user.
 * @property {LegacyUserRaw} [legacy] - The legacy user data.
 * @property {boolean} [is_blue_verified] - Indicates if the user is blue verified.
 */
export interface TimelineUserResultRaw {
  rest_id?: string;
  legacy?: LegacyUserRaw;
  is_blue_verified?: boolean;
}

/**
 * Interface representing the raw content of a timeline entry item.
 * @typedef {Object} TimelineEntryItemContentRaw
 * @property {string} [itemType] - The type of the item.
 * @property {string} [tweetDisplayType] - The display type of the tweet.
 * @property {Object} [tweetResult] - The result of the tweet.
 * @property {Object} [tweet_results] - The results of the tweet.
 * @property {string} [userDisplayType] - The display type of the user.
 * @property {Object} [user_results] - The results of the user.
 */

export interface TimelineEntryItemContentRaw {
  itemType?: string;
  tweetDisplayType?: string;
  tweetResult?: {
    result?: TimelineResultRaw;
  };
  tweet_results?: {
    result?: TimelineResultRaw;
  };
  userDisplayType?: string;
  user_results?: {
    result?: TimelineUserResultRaw;
  };
}

/**
 * Interface representing a raw Timeline Entry.
 * @typedef { Object } TimelineEntryRaw
 * @property { string } entryId - The unique identifier of the entry.
 * @property { Object } [content] - The content of the entry.
 * @property { string } [content.cursorType] - The cursor type of the content.
 * @property { string } [content.value] - The value of the content.
 * @property {Object[]} [content.items] - An array of items within the content.
 * @property { string } [content.items.entryId] - The unique identifier of an item.
 * @property { Object } [content.items.item] - The item within the content.
 * @property { Object } [content.items.item.content] - The content of the item.
 * @property { Object } [content.items.item.itemContent] - The item content of the item.
 */
export interface TimelineEntryRaw {
  entryId: string;
  content?: {
    cursorType?: string;
    value?: string;
    items?: {
      entryId?: string;
      item?: {
        content?: TimelineEntryItemContentRaw;
        itemContent?: SearchEntryItemContentRaw;
      };
    }[];
    itemContent?: TimelineEntryItemContentRaw;
  };
}

/**
 * Interface representing the raw content of a search entry item.
 * @interface
 * @property {string} [tweetDisplayType] - The display type of the tweet.
 * @property {Object} [tweet_results] - The results of the tweet search.
 * @property {Object} [tweet_results.result] - The raw search result of the tweet.
 * @property {string} [userDisplayType] - The display type of the user.
 * @property {Object} [user_results] - The results of the user search.
 * @property {Object} [user_results.result] - The raw search result of the user timeline.
 */
export interface SearchEntryItemContentRaw {
  tweetDisplayType?: string;
  tweet_results?: {
    result?: SearchResultRaw;
  };
  userDisplayType?: string;
  user_results?: {
    result?: TimelineUserResultRaw;
  };
}

/**
 * Interface representing a raw search entry.
 * @typedef { Object } SearchEntryRaw
 * @property { string } entryId - The unique identifier of the entry.
 * @property { string } sortIndex - The sorting index of the entry.
 * @property { Object } [content] - The content details of the entry.
 * @property { string } [content.cursorType] - The type of cursor associated with the entry content.
 * @property { string } [content.entryType] - The type of entry.
 * @property { string } [content.__typename] - The typename of the content.
 * @property { string } [content.value] - The value associated with the entry content.
 * @property {Array<Object>} [content.items] - An array of items associated with the entry.
 * @property { Object } [content.items.item] - An item object associated with the entry.
 * @property { Object } [content.items.item.content] - The content details of the item associated with the entry.
 * @property { Object } [content.itemContent] - The content details of the item associated with the entry.
 */
export interface SearchEntryRaw {
  entryId: string;
  sortIndex: string;
  content?: {
    cursorType?: string;
    entryType?: string;
    __typename?: string;
    value?: string;
    items?: {
      item?: {
        content?: SearchEntryItemContentRaw;
      };
    }[];
    itemContent?: SearchEntryItemContentRaw;
  };
}

/**
 * Interface representing a timeline instruction.
 * @typedef {Object} TimelineInstruction
 * @property {TimelineEntryRaw[]} [entries] - An array of timeline entry raw objects.
 * @property {TimelineEntryRaw} [entry] - A single timeline entry raw object.
 * @property {string} [type] - The type of the timeline instruction.
 */
export interface TimelineInstruction {
  entries?: TimelineEntryRaw[];
  entry?: TimelineEntryRaw;
  type?: string;
}

/**
 * Interface representing version 2 of a timeline object.
 * @typedef {Object} TimelineV2
 * @property {Object} data - Data object containing user information.
 * @property {Object} data.user - User object containing result information.
 * @property {Object} data.user.result - Result object containing timeline_v2 information.
 * @property {Object} data.user.result.timeline_v2 - Timeline_v2 object containing timeline information.
 * @property {Object} data.user.result.timeline_v2.timeline - Timeline object containing instructions.
 * @property {Array<TimelineInstruction>} data.user.result.timeline_v2.timeline.instructions - Array of timeline instructions.
 */
export interface TimelineV2 {
  data?: {
    user?: {
      result?: {
        timeline_v2?: {
          timeline?: {
            instructions?: TimelineInstruction[];
          };
        };
      };
    };
  };
}

/**
 * Represents a threaded conversation with optional data.
 * @interface
 * @property {Object} data - Optional data for the conversation.
 * @property {Object} data.threaded_conversation_with_injections_v2 - Optional object containing instructions.
 * @property {TimelineInstruction[]} data.threaded_conversation_with_injections_v2.instructions - Array of timeline instructions.
 */
export interface ThreadedConversation {
  data?: {
    threaded_conversation_with_injections_v2?: {
      instructions?: TimelineInstruction[];
    };
  };
}

/**
 * Parses a legacy tweet object and returns a ParseTweetResult.
 * @param {LegacyUserRaw} [user] - The legacy user object.
 * @param {LegacyTweetRaw} [tweet] - The legacy tweet object.
 * @returns {ParseTweetResult} The result of parsing the legacy tweet.
 */
export function parseLegacyTweet(user?: LegacyUserRaw, tweet?: LegacyTweetRaw): ParseTweetResult {
  if (tweet == null) {
    return {
      success: false,
      err: new Error('Tweet was not found in the timeline object.'),
    };
  }

  if (user == null) {
    return {
      success: false,
      err: new Error('User was not found in the timeline object.'),
    };
  }

  if (!tweet.id_str) {
    if (!tweet.conversation_id_str) {
      return {
        success: false,
        err: new Error('Tweet ID was not found in object.'),
      };
    }

    tweet.id_str = tweet.conversation_id_str;
  }

  const hashtags = tweet.entities?.hashtags ?? [];
  const mentions = tweet.entities?.user_mentions ?? [];
  const media = tweet.extended_entities?.media ?? [];
  const pinnedTweets = new Set<string | undefined>(user.pinned_tweet_ids_str ?? []);
  const urls = tweet.entities?.urls ?? [];
  const { photos, videos, sensitiveContent } = parseMediaGroups(media);

  const tw: Tweet = {
    bookmarkCount: tweet.bookmark_count,
    conversationId: tweet.conversation_id_str,
    id: tweet.id_str,
    hashtags: hashtags.filter(isFieldDefined('text')).map((hashtag) => hashtag.text),
    likes: tweet.favorite_count,
    mentions: mentions.filter(isFieldDefined('id_str')).map((mention) => ({
      id: mention.id_str,
      username: mention.screen_name,
      name: mention.name,
    })),
    name: user.name,
    permanentUrl: `https://twitter.com/${user.screen_name}/status/${tweet.id_str}`,
    photos,
    replies: tweet.reply_count,
    retweets: tweet.retweet_count,
    text: tweet.full_text,
    thread: [],
    urls: urls.filter(isFieldDefined('expanded_url')).map((url) => url.expanded_url),
    userId: tweet.user_id_str,
    username: user.screen_name,
    videos,
    isQuoted: false,
    isReply: false,
    isRetweet: false,
    isPin: false,
    sensitiveContent: false,
  };

  if (tweet.created_at) {
    tw.timeParsed = new Date(Date.parse(tweet.created_at));
    tw.timestamp = Math.floor(tw.timeParsed.valueOf() / 1000);
  }

  if (tweet.place?.id) {
    tw.place = tweet.place;
  }

  const quotedStatusIdStr = tweet.quoted_status_id_str;
  const inReplyToStatusIdStr = tweet.in_reply_to_status_id_str;
  const retweetedStatusIdStr = tweet.retweeted_status_id_str;
  const retweetedStatusResult = tweet.retweeted_status_result?.result;

  if (quotedStatusIdStr) {
    tw.isQuoted = true;
    tw.quotedStatusId = quotedStatusIdStr;
  }

  if (inReplyToStatusIdStr) {
    tw.isReply = true;
    tw.inReplyToStatusId = inReplyToStatusIdStr;
  }

  if (retweetedStatusIdStr || retweetedStatusResult) {
    tw.isRetweet = true;
    tw.retweetedStatusId = retweetedStatusIdStr;

    if (retweetedStatusResult) {
      const parsedResult = parseLegacyTweet(
        retweetedStatusResult?.core?.user_results?.result?.legacy,
        retweetedStatusResult?.legacy
      );

      if (parsedResult.success) {
        tw.retweetedStatus = parsedResult.tweet;
      }
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
 * Parses a raw timeline result object into a ParseTweetResult object.
 *
 * @param {TimelineResultRaw} result - The raw timeline result object to parse.
 * @returns {ParseTweetResult} The parsed tweet result object.
 */
function parseResult(result?: TimelineResultRaw): ParseTweetResult {
  const noteTweetResultText = result?.note_tweet?.note_tweet_results?.result?.text;

  if (result?.legacy && noteTweetResultText) {
    result.legacy.full_text = noteTweetResultText;
  }

  const tweetResult = parseLegacyTweet(result?.core?.user_results?.result?.legacy, result?.legacy);
  if (!tweetResult.success) {
    return tweetResult;
  }

  if (!tweetResult.tweet.views && result?.views?.count) {
    const views = Number.parseInt(result.views.count);
    if (!Number.isNaN(views)) {
      tweetResult.tweet.views = views;
    }
  }

  const quotedResult = result?.quoted_status_result?.result;
  if (quotedResult) {
    if (quotedResult.legacy && quotedResult.rest_id) {
      quotedResult.legacy.id_str = quotedResult.rest_id;
    }

    const quotedTweetResult = parseResult(quotedResult);
    if (quotedTweetResult.success) {
      tweetResult.tweet.quotedStatus = quotedTweetResult.tweet;
    }
  }

  return tweetResult;
}

const expectedEntryTypes = ['tweet', 'profile-conversation'];

/**
 * Parses the timeline tweets from a TimelineV2 object and returns the QueryTweetsResponse.
 * @param {TimelineV2} timeline The timeline object containing the tweet data.
 * @returns {QueryTweetsResponse} The parsed tweets along with the next and previous cursors.
 */
export function parseTimelineTweetsV2(timeline: TimelineV2): QueryTweetsResponse {
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;
  const tweets: Tweet[] = [];
  const instructions = timeline.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [];
  for (const instruction of instructions) {
    const entries = instruction.entries ?? [];

    for (const entry of entries) {
      const entryContent = entry.content;
      if (!entryContent) continue;

      // Handle pagination
      if (entryContent.cursorType === 'Bottom') {
        bottomCursor = entryContent.value;
        continue;
      }
      if (entryContent.cursorType === 'Top') {
        topCursor = entryContent.value;
        continue;
      }

      const idStr = entry.entryId;
      if (!expectedEntryTypes.some((entryType) => idStr.startsWith(entryType))) {
        continue;
      }

      if (entryContent.itemContent) {
        // Typically TimelineTimelineTweet entries
        parseAndPush(tweets, entryContent.itemContent, idStr);
      } else if (entryContent.items) {
        // Typically TimelineTimelineModule entries
        for (const item of entryContent.items) {
          if (item.item?.itemContent) {
            parseAndPush(tweets, item.item.itemContent, idStr);
          }
        }
      }
    }
  }

  return { tweets, next: bottomCursor, previous: topCursor };
}

/**
 * Parses the raw content of a timeline entry item to extract the tweet data.
 * @param {TimelineEntryItemContentRaw} content - The raw content of the timeline entry item
 * @param {string} entryId - The entry ID of the timeline entry
 * @param {boolean} [isConversation=false] - Indicates if the timeline entry is part of a conversation
 * @returns {Tweet | null} The parsed tweet data or null if the parsing was unsuccessful
 */
export function parseTimelineEntryItemContentRaw(
  content: TimelineEntryItemContentRaw,
  entryId: string,
  isConversation = false
) {
  let result = content.tweet_results?.result ?? content.tweetResult?.result;
  if (
    result?.__typename === 'Tweet' ||
    (result?.__typename === 'TweetWithVisibilityResults' && result?.tweet)
  ) {
    if (result?.__typename === 'TweetWithVisibilityResults') result = result.tweet;

    if (result?.legacy) {
      result.legacy.id_str =
        result.rest_id ?? entryId.replace('conversation-', '').replace('tweet-', '');
    }

    const tweetResult = parseResult(result);
    if (tweetResult.success) {
      if (isConversation) {
        if (content?.tweetDisplayType === 'SelfThread') {
          tweetResult.tweet.isSelfThread = true;
        }
      }

      return tweetResult.tweet;
    }
  }

  return null;
}

/**
 * Parses the given content and pushes the resulting Tweet object to the specified array.
 *
 * @param {Tweet[]} tweets - The array to push the parsed Tweet object to.
 * @param {TimelineEntryItemContentRaw} content - The raw content to parse.
 * @param {string} entryId - The ID of the timeline entry.
 * @param {boolean} [isConversation=false] - Indicates if the tweet is part of a conversation.
 */
export function parseAndPush(
  tweets: Tweet[],
  content: TimelineEntryItemContentRaw,
  entryId: string,
  isConversation = false
) {
  const tweet = parseTimelineEntryItemContentRaw(content, entryId, isConversation);

  if (tweet) {
    tweets.push(tweet);
  }
}

/**
 * Parses a threaded conversation object and returns an array of Tweets.
 * @param conversation The threaded conversation object to parse
 * @returns An array of Tweet objects parsed from the conversation
 */
export function parseThreadedConversation(conversation: ThreadedConversation): Tweet[] {
  const tweets: Tweet[] = [];
  const instructions =
    conversation.data?.threaded_conversation_with_injections_v2?.instructions ?? [];

  for (const instruction of instructions) {
    const entries = instruction.entries ?? [];
    for (const entry of entries) {
      const entryContent = entry.content?.itemContent;
      if (entryContent) {
        parseAndPush(tweets, entryContent, entry.entryId, true);
      }

      for (const item of entry.content?.items ?? []) {
        const itemContent = item.item?.itemContent;
        if (itemContent) {
          parseAndPush(tweets, itemContent, entry.entryId, true);
        }
      }
    }
  }

  for (const tweet of tweets) {
    if (tweet.inReplyToStatusId) {
      for (const parentTweet of tweets) {
        if (parentTweet.id === tweet.inReplyToStatusId) {
          tweet.inReplyToStatus = parentTweet;
          break;
        }
      }
    }

    if (tweet.isSelfThread && tweet.conversationId === tweet.id) {
      for (const childTweet of tweets) {
        if (childTweet.isSelfThread && childTweet.id !== tweet.id) {
          tweet.thread.push(childTweet);
        }
      }

      if (tweet.thread.length === 0) {
        tweet.isSelfThread = false;
      }
    }
  }

  return tweets;
}

/**
 * Interface representing a timeline article.
 * @typedef {Object} TimelineArticle
 * @property {string} id - The unique identifier for the article.
 * @property {string} articleId - The identifier for the article.
 * @property {string} title - The title of the article.
 * @property {string} previewText - The preview text of the article.
 * @property {string} [coverMediaUrl] - The URL of the cover media for the article. (Optional)
 * @property {string} text - The main text content of the article.
 */
export interface TimelineArticle {
  id: string;
  articleId: string;
  title: string;
  previewText: string;
  coverMediaUrl?: string;
  text: string;
}

/**
 * Parses a ThreadedConversation object to extract TimelineArticle objects.
 *
 * @param {ThreadedConversation} conversation - The ThreadedConversation object to parse.
 * @returns {TimelineArticle[]} The extracted TimelineArticle objects.
 */
export function parseArticle(conversation: ThreadedConversation): TimelineArticle[] {
  const articles: TimelineArticle[] = [];
  for (const instruction of conversation.data?.threaded_conversation_with_injections_v2
    ?.instructions ?? []) {
    for (const entry of instruction.entries ?? []) {
      const id = entry.content?.itemContent?.tweet_results?.result?.rest_id;
      const article =
        entry.content?.itemContent?.tweet_results?.result?.article?.article_results?.result;
      if (!id || !article) continue;
      const text = article.content_state?.blocks?.map((block) => block.text).join('\n\n') ?? '';
      articles.push({
        id,
        articleId: article.rest_id || '',
        coverMediaUrl: article.cover_media?.media_info?.original_img_url,
        previewText: article.preview_text || '',
        text,
        title: article.title || '',
      });
    }
  }
  return articles;
}
