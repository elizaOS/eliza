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

export interface TimelineUserResultRaw {
  rest_id?: string;
  legacy?: LegacyUserRaw;
  is_blue_verified?: boolean;
}

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

export interface TimelineInstruction {
  entries?: TimelineEntryRaw[];
  entry?: TimelineEntryRaw;
  type?: string;
}

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

export interface ThreadedConversation {
  data?: {
    threaded_conversation_with_injections_v2?: {
      instructions?: TimelineInstruction[];
    };
  };
}

export function parseLegacyTweet(
  user?: LegacyUserRaw,
  tweet?: LegacyTweetRaw,
): ParseTweetResult {
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
  const pinnedTweets = new Set<string | undefined>(
    user.pinned_tweet_ids_str ?? [],
  );
  const urls = tweet.entities?.urls ?? [];
  const { photos, videos, sensitiveContent } = parseMediaGroups(media);

  const tw: Tweet = {
    bookmarkCount: tweet.bookmark_count,
    conversationId: tweet.conversation_id_str,
    id: tweet.id_str,
    hashtags: hashtags
      .filter(isFieldDefined('text'))
      .map((hashtag) => hashtag.text),
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
    urls: urls
      .filter(isFieldDefined('expanded_url'))
      .map((url) => url.expanded_url),
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
        retweetedStatusResult?.legacy,
      );

      if (parsedResult.success) {
        tw.retweetedStatus = parsedResult.tweet;
      }
    }
  }

  const views = Number.parseInt(tweet.ext_views?.count ?? '');
  if (!isNaN(views)) {
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

function parseResult(result?: TimelineResultRaw): ParseTweetResult {
  const noteTweetResultText =
    result?.note_tweet?.note_tweet_results?.result?.text;

  if (result?.legacy && noteTweetResultText) {
    result.legacy.full_text = noteTweetResultText;
  }

  const tweetResult = parseLegacyTweet(
    result?.core?.user_results?.result?.legacy,
    result?.legacy,
  );
  if (!tweetResult.success) {
    return tweetResult;
  }

  if (!tweetResult.tweet.views && result?.views?.count) {
    const views = Number.parseInt(result.views.count);
    if (!isNaN(views)) {
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

export function parseTimelineTweetsV2(
  timeline: TimelineV2,
): QueryTweetsResponse {
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;
  const tweets: Tweet[] = [];
  const instructions =
    timeline.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [];
  for (const instruction of instructions) {
    const entries = instruction.entries ?? [];

    for (const entry of entries) {
      const entryContent = entry.content;
      if (!entryContent) continue;

      // Handle pagination
      if (entryContent.cursorType === 'Bottom') {
        bottomCursor = entryContent.value;
        continue;
      } else if (entryContent.cursorType === 'Top') {
        topCursor = entryContent.value;
        continue;
      }

      const idStr = entry.entryId;
      if (
        !expectedEntryTypes.some((entryType) => idStr.startsWith(entryType))
      ) {
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

export function parseTimelineEntryItemContentRaw(
  content: TimelineEntryItemContentRaw,
  entryId: string,
  isConversation = false,
) {
  let result = content.tweet_results?.result ?? content.tweetResult?.result;
  if (
    result?.__typename === 'Tweet' ||
    (result?.__typename === 'TweetWithVisibilityResults' && result?.tweet)
  ) {
    if (result?.__typename === 'TweetWithVisibilityResults')
      result = result.tweet;

    if (result?.legacy) {
      result.legacy.id_str =
        result.rest_id ??
        entryId.replace('conversation-', '').replace('tweet-', '');
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

export function parseAndPush(
  tweets: Tweet[],
  content: TimelineEntryItemContentRaw,
  entryId: string,
  isConversation = false,
) {
  const tweet = parseTimelineEntryItemContentRaw(
    content,
    entryId,
    isConversation,
  );

  if (tweet) {
    tweets.push(tweet);
  }
}

export function parseThreadedConversation(
  conversation: ThreadedConversation,
): Tweet[] {
  const tweets: Tweet[] = [];
  const instructions =
    conversation.data?.threaded_conversation_with_injections_v2?.instructions ??
    [];

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

export interface TimelineArticle {
  id: string;
  articleId: string;
  title: string;
  previewText: string;
  coverMediaUrl?: string;
  text: string;
}

export function parseArticle(
  conversation: ThreadedConversation,
): TimelineArticle[] {
  const articles: TimelineArticle[] = [];
  for (const instruction of conversation.data
    ?.threaded_conversation_with_injections_v2?.instructions ?? []) {
    for (const entry of instruction.entries ?? []) {
      const id = entry.content?.itemContent?.tweet_results?.result?.rest_id;
      const article =
        entry.content?.itemContent?.tweet_results?.result?.article
          ?.article_results?.result;
      if (!id || !article) continue;
      const text =
        article.content_state?.blocks
          ?.map((block) => block.text)
          .join('\n\n') ?? '';
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
