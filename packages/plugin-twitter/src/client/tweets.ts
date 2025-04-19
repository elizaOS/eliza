import type {
  ApiV2Includes,
  MediaObjectV2,
  PlaceV2,
  PollV2,
  TTweetv2Expansion,
  TTweetv2MediaField,
  TTweetv2PlaceField,
  TTweetv2PollField,
  TTweetv2TweetField,
  TTweetv2UserField,
  TweetV2,
  UserV2,
} from 'twitter-api-v2';
import { addApiFeatures, requestApi } from './api';
import { apiRequestFactory } from './api-data';
import type { TwitterAuth } from './auth';
import { getEntityIdByScreenName } from './profile';
import { updateCookieJar } from './requests';
import { getTweetTimeline } from './timeline-async';
import { type ListTimeline, parseListTimelineTweets } from './timeline-list';
import type { QueryTweetsResponse } from './timeline-v1';
import {
  type ThreadedConversation,
  type TimelineArticle,
  type TimelineEntryItemContentRaw,
  type TimelineV2,
  parseArticle,
  parseThreadedConversation,
  parseTimelineEntryItemContentRaw,
  parseTimelineTweetsV2,
} from './timeline-v2';

/**
 * Default options for Twitter API v2 request parameters.
 * @typedef {Object} defaultOptions
 * @property {TTweetv2Expansion[]} expansions - List of expansions to include in the request.
 * @property {TTweetv2TweetField[]} tweetFields - List of tweet fields to include in the request.
 * @property {TTweetv2PollField[]} pollFields - List of poll fields to include in the request.
 * @property {TTweetv2MediaField[]} mediaFields - List of media fields to include in the request.
 * @property {TTweetv2UserField[]} userFields - List of user fields to include in the request.
 * @property {TTweetv2PlaceField[]} placeFields - List of place fields to include in the request.
 */
export const defaultOptions = {
  expansions: [
    'attachments.poll_ids',
    'attachments.media_keys',
    'author_id',
    'referenced_tweets.id',
    'in_reply_to_user_id',
    'edit_history_tweet_ids',
    'geo.place_id',
    'entities.mentions.username',
    'referenced_tweets.id.author_id',
  ] as TTweetv2Expansion[],
  tweetFields: [
    'attachments',
    'author_id',
    'context_annotations',
    'conversation_id',
    'created_at',
    'entities',
    'geo',
    'id',
    'in_reply_to_user_id',
    'lang',
    'public_metrics',
    'edit_controls',
    'possibly_sensitive',
    'referenced_tweets',
    'reply_settings',
    'source',
    'text',
    'withheld',
    'note_tweet',
  ] as TTweetv2TweetField[],
  pollFields: [
    'duration_minutes',
    'end_datetime',
    'id',
    'options',
    'voting_status',
  ] as TTweetv2PollField[],
  mediaFields: [
    'duration_ms',
    'height',
    'media_key',
    'preview_image_url',
    'type',
    'url',
    'width',
    'public_metrics',
    'alt_text',
    'variants',
  ] as TTweetv2MediaField[],
  userFields: [
    'created_at',
    'description',
    'entities',
    'id',
    'location',
    'name',
    'profile_image_url',
    'protected',
    'public_metrics',
    'url',
    'username',
    'verified',
    'withheld',
  ] as TTweetv2UserField[],
  placeFields: [
    'contained_within',
    'country',
    'country_code',
    'full_name',
    'geo',
    'id',
    'name',
    'place_type',
  ] as TTweetv2PlaceField[],
};
/**
 * Interface representing a mention.
 * @typedef {Object} Mention
 * @property {string} id - The unique identifier for the mention.
 * @property {string} [username] - The username associated with the mention.
 * @property {string} [name] - The name associated with the mention.
 */
export interface Mention {
  id: string;
  username?: string;
  name?: string;
}

/**
 * Interface representing a photo object.
 * @interface
 * @property {string} id - The unique identifier for the photo.
 * @property {string} url - The URL for the photo image.
 * @property {string} [alt_text] - The alternative text for the photo image. Optional.
 */
export interface Photo {
  id: string;
  url: string;
  alt_text: string | undefined;
}

/**
 * Interface representing a video object.
 * @typedef {Object} Video
 * @property {string} id - The unique identifier for the video.
 * @property {string} preview - The URL for the preview image of the video.
 * @property {string} [url] - The optional URL for the video.
 */

export interface Video {
  id: string;
  preview: string;
  url?: string;
}

/**
 * Interface representing a raw place object.
 * @typedef {Object} PlaceRaw
 * @property {string} [id] - The unique identifier of the place.
 * @property {string} [place_type] - The type of the place.
 * @property {string} [name] - The name of the place.
 * @property {string} [full_name] - The full name of the place.
 * @property {string} [country_code] - The country code of the place.
 * @property {string} [country] - The country name of the place.
 * @property {Object} [bounding_box] - The bounding box coordinates of the place.
 * @property {string} [bounding_box.type] - The type of the bounding box.
 * @property {number[][][]} [bounding_box.coordinates] - The coordinates of the bounding box in an array format.
 */
export interface PlaceRaw {
  id?: string;
  place_type?: string;
  name?: string;
  full_name?: string;
  country_code?: string;
  country?: string;
  bounding_box?: {
    type?: string;
    coordinates?: number[][][];
  };
}

/**
 * Interface representing poll data.
 *
 * @property {string} [id] - The unique identifier for the poll.
 * @property {string} [end_datetime] - The end date and time for the poll.
 * @property {string} [voting_status] - The status of the voting process.
 * @property {number} duration_minutes - The duration of the poll in minutes.
 * @property {PollOption[]} options - An array of poll options.
 */
export interface PollData {
  id?: string;
  end_datetime?: string;
  voting_status?: string;
  duration_minutes: number;
  options: PollOption[];
}

/**
 * Interface representing a poll option.
 * @typedef {Object} PollOption
 * @property {number} [position] - The position of the option.
 * @property {string} label - The label of the option.
 * @property {number} [votes] - The number of votes for the option.
 */
export interface PollOption {
  position?: number;
  label: string;
  votes?: number;
}

/**
 * A parsed Tweet object.
 */
/**
 * Represents a Tweet on Twitter.
 * @typedef { Object } Tweet
 * @property { number } [bookmarkCount] - The number of times this Tweet has been bookmarked.
 * @property { string } [conversationId] - The ID of the conversation this Tweet is a part of.
 * @property {string[]} hashtags - An array of hashtags mentioned in the Tweet.
 * @property { string } [html] - The HTML content of the Tweet.
 * @property { string } [id] - The unique ID of the Tweet.
 * @property { Tweet } [inReplyToStatus] - The Tweet that this Tweet is in reply to.
 * @property { string } [inReplyToStatusId] - The ID of the Tweet that this Tweet is in reply to.
 * @property { boolean } [isQuoted] - Indicates if this Tweet is a quote of another Tweet.
 * @property { boolean } [isPin] - Indicates if this Tweet is pinned.
 * @property { boolean } [isReply] - Indicates if this Tweet is a reply to another Tweet.
 * @property { boolean } [isRetweet] - Indicates if this Tweet is a retweet.
 * @property { boolean } [isSelfThread] - Indicates if this Tweet is part of a self thread.
 * @property { string } [language] - The language of the Tweet.
 * @property { number } [likes] - The number of likes on the Tweet.
 * @property { string } [name] - The name associated with the Tweet.
 * @property {Mention[]} mentions - An array of mentions in the Tweet.
 * @property { string } [permanentUrl] - The permanent URL of the Tweet.
 * @property {Photo[]} photos - An array of photos attached to the Tweet.
 * @property { PlaceRaw } [place] - The place associated with the Tweet.
 * @property { Tweet } [quotedStatus] - The quoted Tweet.
 * @property { string } [quotedStatusId] - The ID of the quoted Tweet.
 * @property { number } [quotes] - The number of times this Tweet has been quoted.
 * @property { number } [replies] - The number of replies to the Tweet.
 * @property { number } [retweets] - The number of retweets on the Tweet.
 * @property { Tweet } [retweetedStatus] - The status that was retweeted.
 * @property { string } [retweetedStatusId] - The ID of the retweeted status.
 * @property { string } [text] - The text content of the Tweet.
 * @property {Tweet[]} thread - An array representing a Twitter thread.
 * @property { Date } [timeParsed] - The parsed timestamp of the Tweet.
 * @property { number } [timestamp] - The timestamp of the Tweet.
 * @property {string[]} urls - An array of URLs mentioned in the Tweet.
 * @property { string } [userId] - The ID of the user who posted the Tweet.
 * @property { string } [username] - The username of the user who posted the Tweet.
 * @property {Video[]} videos - An array of videos attached to the Tweet.
 * @property { number } [views] - The number of views on the Tweet.
 * @property { boolean } [sensitiveContent] - Indicates if the Tweet contains sensitive content.
 * @property {PollV2 | null} [poll] - The poll attached to the Tweet, if any.
 */
export interface Tweet {
  bookmarkCount?: number;
  conversationId?: string;
  hashtags: string[];
  html?: string;
  id?: string;
  inReplyToStatus?: Tweet;
  inReplyToStatusId?: string;
  isQuoted?: boolean;
  isPin?: boolean;
  isReply?: boolean;
  isRetweet?: boolean;
  isSelfThread?: boolean;
  language?: string;
  likes?: number;
  name?: string;
  mentions: Mention[];
  permanentUrl?: string;
  photos: Photo[];
  place?: PlaceRaw;
  quotedStatus?: Tweet;
  quotedStatusId?: string;
  quotes?: number;
  replies?: number;
  retweets?: number;
  retweetedStatus?: Tweet;
  retweetedStatusId?: string;
  text?: string;
  thread: Tweet[];
  timeParsed?: Date;
  timestamp?: number;
  urls: string[];
  userId?: string;
  username?: string;
  videos: Video[];
  views?: number;
  sensitiveContent?: boolean;
  poll?: PollV2 | null;
}

export interface Retweeter {
  rest_id: string;
  screen_name: string;
  name: string;
  description?: string;
}

export type TweetQuery = Partial<Tweet> | ((tweet: Tweet) => boolean | Promise<boolean>);

export const features = addApiFeatures({
  interactive_text_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_text_conversations_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
  vibe_api_enabled: false,
});

export async function fetchTweets(
  userId: string,
  maxTweets: number,
  cursor: string | undefined,
  auth: TwitterAuth
): Promise<QueryTweetsResponse> {
  if (maxTweets > 200) {
    maxTweets = 200;
  }

  const userTweetsRequest = apiRequestFactory.createUserTweetsRequest();
  userTweetsRequest.variables.userId = userId;
  userTweetsRequest.variables.count = maxTweets;
  userTweetsRequest.variables.includePromotedContent = false; // true on the website

  if (cursor != null && cursor !== '') {
    userTweetsRequest.variables.cursor = cursor;
  }

  const res = await requestApi<TimelineV2>(userTweetsRequest.toRequestUrl(), auth);

  if (!res.success) {
    throw (res as any).err;
  }

  return parseTimelineTweetsV2(res.value);
}

export async function fetchTweetsAndReplies(
  userId: string,
  maxTweets: number,
  cursor: string | undefined,
  auth: TwitterAuth
): Promise<QueryTweetsResponse> {
  if (maxTweets > 40) {
    maxTweets = 40;
  }

  const userTweetsRequest = apiRequestFactory.createUserTweetsAndRepliesRequest();
  userTweetsRequest.variables.userId = userId;
  userTweetsRequest.variables.count = maxTweets;
  userTweetsRequest.variables.includePromotedContent = false; // true on the website

  if (cursor != null && cursor !== '') {
    userTweetsRequest.variables.cursor = cursor;
  }

  const res = await requestApi<TimelineV2>(userTweetsRequest.toRequestUrl(), auth);

  if (!res.success) {
    throw (res as any).err;
  }

  return parseTimelineTweetsV2(res.value);
}

export async function createCreateTweetRequestV2(
  text: string,
  auth: TwitterAuth,
  tweetId?: string,
  options?: {
    poll?: PollData;
  }
) {
  const v2client = auth.getV2Client();
  if (v2client == null) {
    throw new Error('V2 client is not initialized');
  }
  const { poll } = options || {};
  let tweetConfig;
  if (poll) {
    tweetConfig = {
      text,
      poll: {
        options: poll?.options.map((option) => option.label) ?? [],
        duration_minutes: poll?.duration_minutes ?? 60,
      },
    };
  } else if (tweetId) {
    tweetConfig = {
      text,
      reply: {
        in_reply_to_tweet_id: tweetId,
      },
    };
  } else {
    tweetConfig = {
      text,
    };
  }
  const tweetResponse = await v2client.v2.tweet(tweetConfig);
  let optionsConfig = {};
  if (options?.poll) {
    optionsConfig = {
      expansions: ['attachments.poll_ids'],
      pollFields: ['options', 'duration_minutes', 'end_datetime', 'voting_status'],
    };
  }
  return await getTweetV2(tweetResponse.data.id, auth, optionsConfig);
}

export function parseTweetV2ToV1(
  tweetV2: TweetV2,
  includes?: ApiV2Includes,
  defaultTweetData?: Tweet | null
): Tweet {
  let parsedTweet: Tweet;
  if (defaultTweetData != null) {
    parsedTweet = defaultTweetData;
  }
  parsedTweet = {
    id: tweetV2.id,
    text: tweetV2.text ?? defaultTweetData?.text ?? '',
    hashtags: tweetV2.entities?.hashtags?.map((tag) => tag.tag) ?? defaultTweetData?.hashtags ?? [],
    mentions:
      tweetV2.entities?.mentions?.map((mention) => ({
        id: mention.id,
        username: mention.username,
      })) ??
      defaultTweetData?.mentions ??
      [],
    urls: tweetV2.entities?.urls?.map((url) => url.url) ?? defaultTweetData?.urls ?? [],
    likes: tweetV2.public_metrics?.like_count ?? defaultTweetData?.likes ?? 0,
    retweets: tweetV2.public_metrics?.retweet_count ?? defaultTweetData?.retweets ?? 0,
    replies: tweetV2.public_metrics?.reply_count ?? defaultTweetData?.replies ?? 0,
    views: tweetV2.public_metrics?.impression_count ?? defaultTweetData?.views ?? 0,
    userId: tweetV2.author_id ?? defaultTweetData?.userId,
    conversationId: tweetV2.conversation_id ?? defaultTweetData?.conversationId,
    photos: defaultTweetData?.photos ?? [],
    videos: defaultTweetData?.videos ?? [],
    poll: defaultTweetData?.poll ?? null,
    username: defaultTweetData?.username ?? '',
    name: defaultTweetData?.name ?? '',
    place: defaultTweetData?.place,
    thread: defaultTweetData?.thread ?? [],
  };

  // Process Polls
  if (includes?.polls?.length) {
    const poll = includes.polls[0];
    parsedTweet.poll = {
      id: poll.id,
      end_datetime: poll.end_datetime
        ? poll.end_datetime
        : defaultTweetData?.poll?.end_datetime
          ? defaultTweetData?.poll?.end_datetime
          : undefined,
      options: poll.options.map((option) => ({
        position: option.position,
        label: option.label,
        votes: option.votes,
      })),
      voting_status: poll.voting_status ?? defaultTweetData?.poll?.voting_status,
    };
  }

  // Process Media (photos and videos)
  if (includes?.media?.length) {
    includes.media.forEach((media: MediaObjectV2) => {
      if (media.type === 'photo') {
        parsedTweet.photos.push({
          id: media.media_key,
          url: media.url ?? '',
          alt_text: media.alt_text ?? '',
        });
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        parsedTweet.videos.push({
          id: media.media_key,
          preview: media.preview_image_url ?? '',
          url: media.variants?.find((variant) => variant.content_type === 'video/mp4')?.url ?? '',
        });
      }
    });
  }

  // Process User (for author info)
  if (includes?.users?.length) {
    const user = includes.users.find((user: UserV2) => user.id === tweetV2.author_id);
    if (user) {
      parsedTweet.username = user.username ?? defaultTweetData?.username ?? '';
      parsedTweet.name = user.name ?? defaultTweetData?.name ?? '';
    }
  }

  // Process Place (if any)
  if (tweetV2?.geo?.place_id && includes?.places?.length) {
    const place = includes.places.find((place: PlaceV2) => place.id === tweetV2?.geo?.place_id);
    if (place) {
      parsedTweet.place = {
        id: place.id,
        full_name: place.full_name ?? defaultTweetData?.place?.full_name ?? '',
        country: place.country ?? defaultTweetData?.place?.country ?? '',
        country_code: place.country_code ?? defaultTweetData?.place?.country_code ?? '',
        name: place.name ?? defaultTweetData?.place?.name ?? '',
        place_type: place.place_type ?? defaultTweetData?.place?.place_type,
      };
    }
  }

  // TODO: Process Thread (referenced tweets) and remove reference to v1
  return parsedTweet;
}

export async function createCreateTweetRequest(
  text: string,
  auth: TwitterAuth,
  tweetId?: string,
  mediaData?: { data: Buffer; mediaType: string }[],
  hideLinkPreview = false
) {
  const onboardingTaskUrl = 'https://api.twitter.com/1.1/onboarding/task.json';

  const cookies = await auth.cookieJar().getCookies(onboardingTaskUrl);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  //@ ts-expect-error - This is a private API.
  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(onboardingTaskUrl),
    'content-type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'x-csrf-token': xCsrfToken?.value as string,
  });

  const variables: Record<string, any> = {
    tweet_text: text,
    dark_request: false,
    media: {
      media_entities: [],
      possibly_sensitive: false,
    },
    semantic_annotation_ids: [],
  };

  if (hideLinkPreview) {
    variables.card_uri = 'tombstone://card';
  }

  if (mediaData && mediaData.length > 0) {
    const mediaIds = await Promise.all(
      mediaData.map(({ data, mediaType }) => uploadMedia(data, auth, mediaType))
    );

    variables.media.media_entities = mediaIds.map((id) => ({
      media_id: id,
      tagged_users: [],
    }));
  }

  if (tweetId) {
    variables.reply = { in_reply_to_tweet_id: tweetId };
  }

  const response = await fetch(
    'https://twitter.com/i/api/graphql/a1p9RWpkYKBjWv_I3WzS-A/CreateTweet',
    {
      headers,
      body: JSON.stringify({
        variables,
        features: {
          interactive_text_enabled: true,
          longform_notetweets_inline_media_enabled: false,
          responsive_web_text_conversations_enabled: false,
          tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
          vibe_api_enabled: false,
          rweb_lists_timeline_redesign_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
          creator_subscriptions_tweet_preview_api_enabled: true,
          responsive_web_graphql_timeline_navigation_enabled: true,
          responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
          tweetypie_unmention_optimization_enabled: true,
          responsive_web_edit_tweet_api_enabled: true,
          graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
          view_counts_everywhere_api_enabled: true,
          longform_notetweets_consumption_enabled: true,
          tweet_awards_web_tipping_enabled: false,
          freedom_of_speech_not_reach_fetch_enabled: true,
          standardized_nudges_misinfo: true,
          longform_notetweets_rich_text_read_enabled: true,
          responsive_web_enhance_cards_enabled: false,
          subscriptions_verification_info_enabled: true,
          subscriptions_verification_info_reason_enabled: true,
          subscriptions_verification_info_verified_since_enabled: true,
          super_follow_badge_privacy_enabled: false,
          super_follow_exclusive_tweet_notifications_enabled: false,
          super_follow_tweet_api_enabled: false,
          super_follow_user_api_enabled: false,
          android_graphql_skip_api_media_color_palette: false,
          creator_subscriptions_subscription_count_enabled: false,
          blue_business_profile_image_shape_enabled: false,
          unified_cards_ad_metadata_container_dynamic_card_content_query_enabled: false,
          rweb_video_timestamps_enabled: false,
          c9s_tweet_anatomy_moderator_badge_enabled: false,
          responsive_web_twitter_article_tweet_consumption_enabled: false,
        },
        fieldToggles: {},
      }),
      method: 'POST',
    }
  );

  await updateCookieJar(auth.cookieJar(), response.headers);

  // check for errors
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response;
}

export async function createCreateNoteTweetRequest(
  text: string,
  auth: TwitterAuth,
  tweetId?: string,
  mediaData?: { data: Buffer; mediaType: string }[]
) {
  const onboardingTaskUrl = 'https://api.twitter.com/1.1/onboarding/task.json';

  const cookies = await auth.cookieJar().getCookies(onboardingTaskUrl);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(onboardingTaskUrl),
    'content-type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'x-csrf-token': xCsrfToken?.value as string,
  });

  const variables: Record<string, any> = {
    tweet_text: text,
    dark_request: false,
    media: {
      media_entities: [],
      possibly_sensitive: false,
    },
    semantic_annotation_ids: [],
  };

  if (mediaData && mediaData.length > 0) {
    const mediaIds = await Promise.all(
      mediaData.map(({ data, mediaType }) => uploadMedia(data, auth, mediaType))
    );

    variables.media.media_entities = mediaIds.map((id) => ({
      media_id: id,
      tagged_users: [],
    }));
  }

  if (tweetId) {
    variables.reply = { in_reply_to_tweet_id: tweetId };
  }

  const response = await fetch(
    'https://twitter.com/i/api/graphql/0aWhJJmFlxkxv9TAUJPanA/CreateNoteTweet',
    {
      headers,
      body: JSON.stringify({
        variables,
        features: {
          interactive_text_enabled: true,
          longform_notetweets_inline_media_enabled: false,
          responsive_web_text_conversations_enabled: false,
          tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
          vibe_api_enabled: false,
          rweb_lists_timeline_redesign_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
          creator_subscriptions_tweet_preview_api_enabled: true,
          responsive_web_graphql_timeline_navigation_enabled: true,
          responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
          tweetypie_unmention_optimization_enabled: true,
          responsive_web_edit_tweet_api_enabled: true,
          graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
          view_counts_everywhere_api_enabled: true,
          longform_notetweets_consumption_enabled: true,
          longform_notetweets_creation_enabled: true,
          tweet_awards_web_tipping_enabled: false,
          freedom_of_speech_not_reach_fetch_enabled: true,
          standardized_nudges_misinfo: true,
          longform_notetweets_rich_text_read_enabled: true,
          responsive_web_enhance_cards_enabled: false,
          subscriptions_verification_info_enabled: true,
          subscriptions_verification_info_reason_enabled: true,
          subscriptions_verification_info_verified_since_enabled: true,
          super_follow_badge_privacy_enabled: false,
          super_follow_exclusive_tweet_notifications_enabled: false,
          super_follow_tweet_api_enabled: false,
          super_follow_user_api_enabled: false,
          android_graphql_skip_api_media_color_palette: false,
          creator_subscriptions_subscription_count_enabled: false,
          blue_business_profile_image_shape_enabled: false,
          unified_cards_ad_metadata_container_dynamic_card_content_query_enabled: false,
          rweb_video_timestamps_enabled: false,
          c9s_tweet_anatomy_moderator_badge_enabled: false,
          responsive_web_twitter_article_tweet_consumption_enabled: false,

          communities_web_enable_tweet_community_results_fetch: false,
          articles_preview_enabled: false,
          rweb_tipjar_consumption_enabled: false,
          creator_subscriptions_quote_tweet_preview_enabled: false,
        },
        fieldToggles: {},
      }),
      method: 'POST',
    }
  );

  await updateCookieJar(auth.cookieJar(), response.headers);

  // Check for errors and log the error response
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Error response:', errorText);
    throw new Error(`Failed to create long tweet: ${errorText}`);
  }

  // Parse and return the response
  const data = await response.json();
  return data;
}

export async function fetchListTweets(
  listId: string,
  maxTweets: number,
  cursor: string | undefined,
  auth: TwitterAuth
): Promise<QueryTweetsResponse> {
  if (maxTweets > 200) {
    maxTweets = 200;
  }

  const listTweetsRequest = apiRequestFactory.createListTweetsRequest();
  listTweetsRequest.variables.listId = listId;
  listTweetsRequest.variables.count = maxTweets;

  if (cursor != null && cursor !== '') {
    listTweetsRequest.variables.cursor = cursor;
  }

  const res = await requestApi<ListTimeline>(listTweetsRequest.toRequestUrl(), auth);

  if (!res.success) {
    throw (res as any).err;
  }

  return parseListTimelineTweets(res.value);
}

export async function deleteTweet(tweetId: string, auth: TwitterAuth) {
  const onboardingTaskUrl = 'https://api.twitter.com/1.1/onboarding/task.json';

  // Retrieve necessary cookies and tokens
  const cookies = await auth.cookieJar().getCookies(onboardingTaskUrl);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(onboardingTaskUrl),
    'content-type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-csrf-token': xCsrfToken?.value as string,
  });

  // Construct variables for the GraphQL request
  const variables: Record<string, any> = {
    tweet_id: tweetId,
    dark_request: false,
  };

  // Send the GraphQL request to delete a tweet
  const response = await fetch(
    'https://twitter.com/i/api/graphql/VaenaVgh5q5ih7kvyVjgtg/DeleteTweet',
    {
      headers,
      body: JSON.stringify({
        variables,
        queryId: 'VaenaVgh5q5ih7kvyVjgtg',
      }),
      method: 'POST',
    }
  );

  // Update the cookie jar with any new cookies from the response
  await updateCookieJar(auth.cookieJar(), response.headers);

  // Check for errors in the response
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response;
}

export function getTweets(
  user: string,
  maxTweets: number,
  auth: TwitterAuth
): AsyncGenerator<Tweet, void> {
  return getTweetTimeline(user, maxTweets, async (q, mt, c) => {
    const userIdRes = await getEntityIdByScreenName(q, auth);

    if (!userIdRes.success) {
      throw (userIdRes as any).err;
    }

    const { value: userId } = userIdRes;

    return fetchTweets(userId, mt, c, auth);
  });
}

export function getTweetsByUserId(
  userId: string,
  maxTweets: number,
  auth: TwitterAuth
): AsyncGenerator<Tweet, void> {
  return getTweetTimeline(userId, maxTweets, (q, mt, c) => {
    return fetchTweets(q, mt, c, auth);
  });
}

export function getTweetsAndReplies(
  user: string,
  maxTweets: number,
  auth: TwitterAuth
): AsyncGenerator<Tweet, void> {
  return getTweetTimeline(user, maxTweets, async (q, mt, c) => {
    const userIdRes = await getEntityIdByScreenName(q, auth);

    if (!userIdRes.success) {
      throw (userIdRes as any).err;
    }

    const { value: userId } = userIdRes;

    return fetchTweetsAndReplies(userId, mt, c, auth);
  });
}

export function getTweetsAndRepliesByUserId(
  userId: string,
  maxTweets: number,
  auth: TwitterAuth
): AsyncGenerator<Tweet, void> {
  return getTweetTimeline(userId, maxTweets, (q, mt, c) => {
    return fetchTweetsAndReplies(q, mt, c, auth);
  });
}

export async function fetchLikedTweets(
  userId: string,
  maxTweets: number,
  cursor: string | undefined,
  auth: TwitterAuth
): Promise<QueryTweetsResponse> {
  if (!auth.isLoggedIn()) {
    throw new Error('Client is not logged-in for fetching liked tweets.');
  }

  if (maxTweets > 200) {
    maxTweets = 200;
  }

  const userTweetsRequest = apiRequestFactory.createUserLikedTweetsRequest();
  userTweetsRequest.variables.userId = userId;
  userTweetsRequest.variables.count = maxTweets;
  userTweetsRequest.variables.includePromotedContent = false; // true on the website

  if (cursor != null && cursor !== '') {
    userTweetsRequest.variables.cursor = cursor;
  }

  const res = await requestApi<TimelineV2>(userTweetsRequest.toRequestUrl(), auth);

  if (!res.success) {
    throw (res as any).err;
  }

  return parseTimelineTweetsV2(res.value);
}

export async function getTweetWhere(
  tweets: AsyncIterable<Tweet>,
  query: TweetQuery
): Promise<Tweet | null> {
  const isCallback = typeof query === 'function';

  for await (const tweet of tweets) {
    const matches = isCallback ? await query(tweet) : checkTweetMatches(tweet, query);

    if (matches) {
      return tweet;
    }
  }

  return null;
}

export async function getTweetsWhere(
  tweets: AsyncIterable<Tweet>,
  query: TweetQuery
): Promise<Tweet[]> {
  const isCallback = typeof query === 'function';
  const filtered = [];

  for await (const tweet of tweets) {
    const matches = isCallback ? query(tweet) : checkTweetMatches(tweet, query);

    if (!matches) continue;
    filtered.push(tweet);
  }

  return filtered;
}

function checkTweetMatches(tweet: Tweet, options: Partial<Tweet>): boolean {
  return Object.keys(options).every((k) => {
    const key = k as keyof Tweet;
    return tweet[key] === options[key];
  });
}

export async function getLatestTweet(
  user: string,
  includeRetweets: boolean,
  max: number,
  auth: TwitterAuth
): Promise<Tweet | null | undefined> {
  const timeline = getTweets(user, max, auth);

  // No point looping if max is 1, just use first entry.
  return max === 1
    ? ((await timeline.next()).value as Tweet)
    : await getTweetWhere(timeline, { isRetweet: includeRetweets });
}

export interface TweetResultByRestId {
  data?: TimelineEntryItemContentRaw;
}

export async function getTweet(id: string, auth: TwitterAuth): Promise<Tweet | null> {
  const tweetDetailRequest = apiRequestFactory.createTweetDetailRequest();
  tweetDetailRequest.variables.focalTweetId = id;

  const res = await requestApi<ThreadedConversation>(tweetDetailRequest.toRequestUrl(), auth);

  if (!res.success) {
    throw (res as any).err;
  }

  if (!res.value) {
    return null;
  }

  const tweets = parseThreadedConversation(res.value);
  return tweets.find((tweet) => tweet.id === id) ?? null;
}

export async function getTweetV2(
  id: string,
  auth: TwitterAuth,
  options: {
    expansions?: TTweetv2Expansion[];
    tweetFields?: TTweetv2TweetField[];
    pollFields?: TTweetv2PollField[];
    mediaFields?: TTweetv2MediaField[];
    userFields?: TTweetv2UserField[];
    placeFields?: TTweetv2PlaceField[];
  } = defaultOptions
): Promise<Tweet | null> {
  const v2client = auth.getV2Client();
  if (!v2client) {
    throw new Error('V2 client is not initialized');
  }

  try {
    const tweetData = await v2client.v2.singleTweet(id, {
      expansions: options?.expansions,
      'tweet.fields': options?.tweetFields,
      'poll.fields': options?.pollFields,
      'media.fields': options?.mediaFields,
      'user.fields': options?.userFields,
      'place.fields': options?.placeFields,
    });

    if (!tweetData?.data) {
      console.warn(`Tweet data not found for ID: ${id}`);
      return null;
    }

    const defaultTweetData = await getTweet(tweetData.data.id, auth);
    // Extract primary tweet data
    const parsedTweet = parseTweetV2ToV1(tweetData.data, tweetData?.includes, defaultTweetData);

    return parsedTweet;
  } catch (error) {
    console.error(`Error fetching tweet ${id}:`, error);
    return null;
  }
}

export async function getTweetsV2(
  ids: string[],
  auth: TwitterAuth,
  options: {
    expansions?: TTweetv2Expansion[];
    tweetFields?: TTweetv2TweetField[];
    pollFields?: TTweetv2PollField[];
    mediaFields?: TTweetv2MediaField[];
    userFields?: TTweetv2UserField[];
    placeFields?: TTweetv2PlaceField[];
  } = defaultOptions
): Promise<Tweet[]> {
  const v2client = auth.getV2Client();
  if (!v2client) {
    return [];
  }

  try {
    const tweetData = await v2client.v2.tweets(ids, {
      expansions: options?.expansions,
      'tweet.fields': options?.tweetFields,
      'poll.fields': options?.pollFields,
      'media.fields': options?.mediaFields,
      'user.fields': options?.userFields,
      'place.fields': options?.placeFields,
    });
    const tweetsV2 = tweetData.data;
    if (tweetsV2.length === 0) {
      console.warn(`No tweet data found for IDs: ${ids.join(', ')}`);
      return [];
    }
    return (
      await Promise.all(tweetsV2.map(async (tweet) => await getTweetV2(tweet.id, auth, options)))
    ).filter((tweet): tweet is Tweet => tweet !== null);
  } catch (error) {
    console.error(`Error fetching tweets for IDs: ${ids.join(', ')}`, error);
    return [];
  }
}

export async function getTweetAnonymous(id: string, auth: TwitterAuth): Promise<Tweet | null> {
  const tweetResultByRestIdRequest = apiRequestFactory.createTweetResultByRestIdRequest();
  tweetResultByRestIdRequest.variables.tweetId = id;

  const res = await requestApi<TweetResultByRestId>(
    tweetResultByRestIdRequest.toRequestUrl(),
    auth
  );

  if (!res.success) {
    throw (res as any).err;
  }

  if (!res.value.data) {
    return null;
  }

  return parseTimelineEntryItemContentRaw(res.value.data, id);
}

interface MediaUploadResponse {
  media_id_string: string;
  size: number;
  expires_after_secs: number;
  image: {
    image_type: string;
    w: number;
    h: number;
  };
}

async function uploadMedia(
  mediaData: Buffer,
  auth: TwitterAuth,
  mediaType: string
): Promise<string> {
  const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';

  // Get authentication headers
  const cookies = await auth.cookieJar().getCookies(uploadUrl);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');
  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(uploadUrl),
    'x-csrf-token': xCsrfToken?.value as string,
  });

  // Detect if media is a video based on mediaType
  const isVideo = mediaType.startsWith('video/');

  if (isVideo) {
    // Handle video upload using chunked media upload
    const mediaId = await uploadVideoInChunks(mediaData, mediaType);
    return mediaId;
  }
  // Handle image upload
  const form = new FormData();
  form.append('media', new Blob([mediaData]));

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers,
    body: form,
  });

  await updateCookieJar(auth.cookieJar(), response.headers);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data: MediaUploadResponse = await response.json();
  return data.media_id_string;

  // Function to upload video in chunks
  async function uploadVideoInChunks(mediaData: Buffer, mediaType: string): Promise<string> {
    // Initialize upload
    const initParams = new URLSearchParams();
    initParams.append('command', 'INIT');
    initParams.append('media_type', mediaType);
    initParams.append('total_bytes', mediaData.length.toString());

    const initResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: initParams,
    });

    if (!initResponse.ok) {
      throw new Error(await initResponse.text());
    }

    const initData = await initResponse.json();
    const mediaId = initData.media_id_string;

    // Append upload in chunks
    const segmentSize = 5 * 1024 * 1024; // 5 MB per chunk
    let segmentIndex = 0;
    for (let offset = 0; offset < mediaData.length; offset += segmentSize) {
      const chunk = mediaData.slice(offset, offset + segmentSize);

      const appendForm = new FormData();
      appendForm.append('command', 'APPEND');
      appendForm.append('media_id', mediaId);
      appendForm.append('segment_index', segmentIndex.toString());
      appendForm.append('media', new Blob([chunk]));

      const appendResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers,
        body: appendForm,
      });

      if (!appendResponse.ok) {
        throw new Error(await appendResponse.text());
      }

      segmentIndex++;
    }

    // Finalize upload
    const finalizeParams = new URLSearchParams();
    finalizeParams.append('command', 'FINALIZE');
    finalizeParams.append('media_id', mediaId);

    const finalizeResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: finalizeParams,
    });

    if (!finalizeResponse.ok) {
      throw new Error(await finalizeResponse.text());
    }

    const finalizeData = await finalizeResponse.json();

    // Check processing status for videos
    if (finalizeData.processing_info) {
      await checkUploadStatus(mediaId);
    }

    return mediaId;
  }

  // Function to check upload status
  async function checkUploadStatus(mediaId: string): Promise<void> {
    let processing = true;
    while (processing) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds

      const statusParams = new URLSearchParams();
      statusParams.append('command', 'STATUS');
      statusParams.append('media_id', mediaId);

      const statusResponse = await fetch(`${uploadUrl}?${statusParams.toString()}`, {
        method: 'GET',
        headers,
      });

      if (!statusResponse.ok) {
        throw new Error(await statusResponse.text());
      }

      const statusData = await statusResponse.json();
      const state = statusData.processing_info.state;

      if (state === 'succeeded') {
        processing = false;
      } else if (state === 'failed') {
        throw new Error('Video processing failed');
      }
    }
  }
}

// Function to create a quote tweet
export async function createQuoteTweetRequest(
  text: string,
  quotedTweetId: string,
  auth: TwitterAuth,
  mediaData?: { data: Buffer; mediaType: string }[]
) {
  const onboardingTaskUrl = 'https://api.twitter.com/1.1/onboarding/task.json';

  // Retrieve necessary cookies and tokens
  const cookies = await auth.cookieJar().getCookies(onboardingTaskUrl);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(onboardingTaskUrl),
    'content-type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-csrf-token': xCsrfToken?.value as string,
  });

  // Construct variables for the GraphQL request
  const variables: Record<string, any> = {
    tweet_text: text,
    dark_request: false,
    attachment_url: `https://twitter.com/twitter/status/${quotedTweetId}`,
    media: {
      media_entities: [],
      possibly_sensitive: false,
    },
    semantic_annotation_ids: [],
  };

  // Handle media uploads if any media data is provided
  if (mediaData && mediaData.length > 0) {
    const mediaIds = await Promise.all(
      mediaData.map(({ data, mediaType }) => uploadMedia(data, auth, mediaType))
    );

    variables.media.media_entities = mediaIds.map((id) => ({
      media_id: id,
      tagged_users: [],
    }));
  }

  // Send the GraphQL request to create a quote tweet
  const response = await fetch(
    'https://twitter.com/i/api/graphql/a1p9RWpkYKBjWv_I3WzS-A/CreateTweet',
    {
      headers,
      body: JSON.stringify({
        variables,
        features: {
          interactive_text_enabled: true,
          longform_notetweets_inline_media_enabled: false,
          responsive_web_text_conversations_enabled: false,
          tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
          vibe_api_enabled: false,
          rweb_lists_timeline_redesign_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
          creator_subscriptions_tweet_preview_api_enabled: true,
          responsive_web_graphql_timeline_navigation_enabled: true,
          responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
          tweetypie_unmention_optimization_enabled: true,
          responsive_web_edit_tweet_api_enabled: true,
          graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
          view_counts_everywhere_api_enabled: true,
          longform_notetweets_consumption_enabled: true,
          tweet_awards_web_tipping_enabled: false,
          freedom_of_speech_not_reach_fetch_enabled: true,
          standardized_nudges_misinfo: true,
          longform_notetweets_rich_text_read_enabled: true,
          responsive_web_enhance_cards_enabled: false,
          subscriptions_verification_info_enabled: true,
          subscriptions_verification_info_reason_enabled: true,
          subscriptions_verification_info_verified_since_enabled: true,
          super_follow_badge_privacy_enabled: false,
          super_follow_exclusive_tweet_notifications_enabled: false,
          super_follow_tweet_api_enabled: false,
          super_follow_user_api_enabled: false,
          android_graphql_skip_api_media_color_palette: false,
          creator_subscriptions_subscription_count_enabled: false,
          blue_business_profile_image_shape_enabled: false,
          unified_cards_ad_metadata_container_dynamic_card_content_query_enabled: false,
          rweb_video_timestamps_enabled: true,
          c9s_tweet_anatomy_moderator_badge_enabled: true,
          responsive_web_twitter_article_tweet_consumption_enabled: false,
        },
        fieldToggles: {},
      }),
      method: 'POST',
    }
  );

  // Update the cookie jar with any new cookies from the response
  await updateCookieJar(auth.cookieJar(), response.headers);

  // Check for errors in the response
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response;
}

/**
 * Likes a tweet with the given tweet ID.
 * @param tweetId The ID of the tweet to like.
 * @param auth The authentication object.
 * @returns A promise that resolves when the tweet is liked.
 */
export async function likeTweet(tweetId: string, auth: TwitterAuth): Promise<void> {
  // Prepare the GraphQL endpoint and payload
  const likeTweetUrl = 'https://twitter.com/i/api/graphql/lI07N6Otwv1PhnEgXILM7A/FavoriteTweet';

  // Retrieve necessary cookies and tokens
  const cookies = await auth.cookieJar().getCookies(likeTweetUrl);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(likeTweetUrl),
    'content-type': 'application/json',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-csrf-token': xCsrfToken?.value as string,
  });

  const payload = {
    variables: {
      tweet_id: tweetId,
    },
  };

  // Send the POST request to like the tweet
  const response = await fetch(likeTweetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  // Update the cookie jar with any new cookies from the response
  await updateCookieJar(auth.cookieJar(), response.headers);

  // Check for errors in the response
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

/**
 * Retweets a tweet with the given tweet ID.
 * @param tweetId The ID of the tweet to retweet.
 * @param auth The authentication object.
 * @returns A promise that resolves when the tweet is retweeted.
 */
export async function retweet(tweetId: string, auth: TwitterAuth): Promise<void> {
  // Prepare the GraphQL endpoint and payload
  const retweetUrl = 'https://twitter.com/i/api/graphql/ojPdsZsimiJrUGLR1sjUtA/CreateRetweet';

  // Retrieve necessary cookies and tokens
  const cookies = await auth.cookieJar().getCookies(retweetUrl);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(retweetUrl),
    'content-type': 'application/json',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-csrf-token': xCsrfToken?.value as string,
  });

  const payload = {
    variables: {
      tweet_id: tweetId,
      dark_request: false,
    },
  };

  // Send the POST request to retweet the tweet
  const response = await fetch(retweetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  // Update the cookie jar with any new cookies from the response
  await updateCookieJar(auth.cookieJar(), response.headers);

  // Check for errors in the response
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

export async function createCreateLongTweetRequest(
  text: string,
  auth: TwitterAuth,
  tweetId?: string,
  mediaData?: { data: Buffer; mediaType: string }[]
) {
  // URL for the long tweet endpoint
  const url = 'https://x.com/i/api/graphql/YNXM2DGuE2Sff6a2JD3Ztw/CreateNoteTweet';
  const onboardingTaskUrl = 'https://api.twitter.com/1.1/onboarding/task.json';

  const cookies = await auth.cookieJar().getCookies(onboardingTaskUrl);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  //@ ts-expect-error - This is a private API.
  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(onboardingTaskUrl),
    'content-type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'x-csrf-token': xCsrfToken?.value as string,
  });

  const variables: Record<string, any> = {
    tweet_text: text,
    dark_request: false,
    media: {
      media_entities: [],
      possibly_sensitive: false,
    },
    semantic_annotation_ids: [],
  };

  if (mediaData && mediaData.length > 0) {
    const mediaIds = await Promise.all(
      mediaData.map(({ data, mediaType }) => uploadMedia(data, auth, mediaType))
    );

    variables.media.media_entities = mediaIds.map((id) => ({
      media_id: id,
      tagged_users: [],
    }));
  }

  if (tweetId) {
    variables.reply = { in_reply_to_tweet_id: tweetId };
  }

  const features = {
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: false,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    articles_preview_enabled: true,
    rweb_video_timestamps_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  };

  const response = await fetch(url, {
    headers,
    body: JSON.stringify({
      variables,
      features,
      queryId: 'YNXM2DGuE2Sff6a2JD3Ztw',
    }),
    method: 'POST',
  });

  await updateCookieJar(auth.cookieJar(), response.headers);

  // check for errors
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response;
}

export async function getArticle(id: string, auth: TwitterAuth): Promise<TimelineArticle | null> {
  const tweetDetailRequest = apiRequestFactory.createTweetDetailArticleRequest();
  tweetDetailRequest.variables.focalTweetId = id;

  const res = await requestApi<ThreadedConversation>(tweetDetailRequest.toRequestUrl(), auth);

  if (!res.success) {
    throw (res as any).err;
  }

  if (!res.value) {
    return null;
  }

  const articles = parseArticle(res.value);
  return articles.find((article) => article.id === id) ?? null;
}

/**
 * Fetches a single page of retweeters for a given tweet, collecting both bottom and top cursors.
 * Logs each user's description in the process.
 * All comments must remain in English.
 */
export async function fetchRetweetersPage(
  tweetId: string,
  auth: TwitterAuth,
  cursor?: string,
  count = 40
): Promise<{
  retweeters: Retweeter[];
  bottomCursor?: string;
  topCursor?: string;
}> {
  const baseUrl = 'https://twitter.com/i/api/graphql/VSnHXwLGADxxtetlPnO7xg/Retweeters';

  // Build query parameters
  const variables = {
    tweetId,
    count,
    cursor,
    includePromotedContent: true,
  };
  const features = {
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: false,
    responsive_web_enhance_cards_enabled: false,
  };

  // Prepare URL with query params
  const url = new URL(baseUrl);
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set('features', JSON.stringify(features));

  // Retrieve necessary cookies and tokens
  const cookies = await auth.cookieJar().getCookies(url.toString());
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(url.toString()),
    'content-type': 'application/json',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-csrf-token': xCsrfToken?.value || '',
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers,
  });

  // Update cookies if needed
  await updateCookieJar(auth.cookieJar(), response.headers);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const json = await response.json();
  const instructions = json?.data?.retweeters_timeline?.timeline?.instructions || [];

  const retweeters: Retweeter[] = [];
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;

  // Parse the retweeters from instructions
  for (const instruction of instructions) {
    if (instruction.type === 'TimelineAddEntries') {
      for (const entry of instruction.entries) {
        // If this entry is a user entry
        if (entry.content?.itemContent?.user_results?.result) {
          const user = entry.content.itemContent.user_results.result;
          const description = user.legacy?.name ?? '';

          retweeters.push({
            rest_id: user.rest_id,
            screen_name: user.legacy?.screen_name ?? '',
            name: user.legacy?.name ?? '',
            description,
          });
        }

        // Capture the bottom cursor
        if (
          entry.content?.entryType === 'TimelineTimelineCursor' &&
          entry.content?.cursorType === 'Bottom'
        ) {
          bottomCursor = entry.content.value;
        }

        // Capture the top cursor
        if (
          entry.content?.entryType === 'TimelineTimelineCursor' &&
          entry.content?.cursorType === 'Top'
        ) {
          topCursor = entry.content.value;
        }
      }
    }
  }

  return { retweeters, bottomCursor, topCursor };
}

/**
 * Retrieves *all* retweeters by chaining requests until no next cursor is found.
 * @param tweetId The ID of the tweet.
 * @param auth The TwitterAuth object for authentication.
 * @returns A list of all users that retweeted the tweet.
 */
export async function getAllRetweeters(tweetId: string, auth: TwitterAuth): Promise<Retweeter[]> {
  let allRetweeters: Retweeter[] = [];
  let cursor: string | undefined;

  while (true) {
    // Destructure bottomCursor / topCursor
    const { retweeters, bottomCursor, topCursor } = await fetchRetweetersPage(
      tweetId,
      auth,
      cursor,
      40
    );
    allRetweeters = allRetweeters.concat(retweeters);

    const newCursor = bottomCursor || topCursor;

    // Stop if there is no new cursor or if it's the same as the old one
    if (!newCursor || newCursor === cursor) {
      break;
    }

    cursor = newCursor;
  }

  return allRetweeters;
}
