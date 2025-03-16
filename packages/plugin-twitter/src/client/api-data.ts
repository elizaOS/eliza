import stringify from 'json-stable-stringify';

/**
 * Examples of requests to API endpoints. These are parsed at runtime and used
 * as templates for requests to a particular endpoint. Please ensure these do
 * not contain any information that you do not want published to NPM.
 */
/**
 * Object containing various endpoint URLs for Twitter API.
 *
 * @type {Object}
 */
const endpoints = {
  // TODO: Migrate other endpoint URLs here
  UserTweets:
    'https://twitter.com/i/api/graphql/V7H0Ap3_Hh2FyS75OCDO3Q/UserTweets?variables=%7B%22userId%22%3A%224020276615%22%2C%22count%22%3A20%2C%22includePromotedContent%22%3Atrue%2C%22withQuickPromoteEligibilityTweetFields%22%3Atrue%2C%22withVoice%22%3Atrue%2C%22withV2Timeline%22%3Atrue%7D&features=%7B%22rweb_tipjar_consumption_enabled%22%3Atrue%2C%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22verified_phone_label_enabled%22%3Afalse%2C%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%2C%22responsive_web_graphql_skip_user_profile_image_extensions_enabled%22%3Afalse%2C%22communities_web_enable_tweet_community_results_fetch%22%3Atrue%2C%22c9s_tweet_anatomy_moderator_badge_enabled%22%3Atrue%2C%22articles_preview_enabled%22%3Atrue%2C%22tweetypie_unmention_optimization_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Atrue%2C%22tweet_awards_web_tipping_enabled%22%3Afalse%2C%22creator_subscriptions_quote_tweet_preview_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22rweb_video_timestamps_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%2C%22responsive_web_enhance_cards_enabled%22%3Afalse%7D&fieldToggles=%7B%22withArticlePlainText%22%3Afalse%7D',
  UserTweetsAndReplies:
    'https://twitter.com/i/api/graphql/E4wA5vo2sjVyvpliUffSCw/UserTweetsAndReplies?variables=%7B%22userId%22%3A%224020276615%22%2C%22count%22%3A40%2C%22cursor%22%3A%22DAABCgABGPWl-F-ATiIKAAIY9YfiF1rRAggAAwAAAAEAAA%22%2C%22includePromotedContent%22%3Atrue%2C%22withCommunity%22%3Atrue%2C%22withVoice%22%3Atrue%2C%22withV2Timeline%22%3Atrue%7D&features=%7B%22rweb_tipjar_consumption_enabled%22%3Atrue%2C%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22verified_phone_label_enabled%22%3Afalse%2C%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%2C%22responsive_web_graphql_skip_user_profile_image_extensions_enabled%22%3Afalse%2C%22communities_web_enable_tweet_community_results_fetch%22%3Atrue%2C%22c9s_tweet_anatomy_moderator_badge_enabled%22%3Atrue%2C%22articles_preview_enabled%22%3Atrue%2C%22tweetypie_unmention_optimization_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Atrue%2C%22tweet_awards_web_tipping_enabled%22%3Afalse%2C%22creator_subscriptions_quote_tweet_preview_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22rweb_video_timestamps_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%2C%22responsive_web_enhance_cards_enabled%22%3Afalse%7D&fieldToggles=%7B%22withArticlePlainText%22%3Afalse%7D',
  UserLikedTweets:
    'https://twitter.com/i/api/graphql/eSSNbhECHHWWALkkQq-YTA/Likes?variables=%7B%22userId%22%3A%222244196397%22%2C%22count%22%3A20%2C%22includePromotedContent%22%3Afalse%2C%22withClientEventToken%22%3Afalse%2C%22withBirdwatchNotes%22%3Afalse%2C%22withVoice%22%3Atrue%2C%22withV2Timeline%22%3Atrue%7D&features=%7B%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22verified_phone_label_enabled%22%3Afalse%2C%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%2C%22responsive_web_graphql_skip_user_profile_image_extensions_enabled%22%3Afalse%2C%22c9s_tweet_anatomy_moderator_badge_enabled%22%3Atrue%2C%22tweetypie_unmention_optimization_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Atrue%2C%22tweet_awards_web_tipping_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22rweb_video_timestamps_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%2C%22responsive_web_enhance_cards_enabled%22%3Afalse%7D',
  TweetDetail:
    'https://twitter.com/i/api/graphql/xOhkmRac04YFZmOzU9PJHg/TweetDetail?variables=%7B%22focalTweetId%22%3A%221237110546383724547%22%2C%22with_rux_injections%22%3Afalse%2C%22includePromotedContent%22%3Atrue%2C%22withCommunity%22%3Atrue%2C%22withQuickPromoteEligibilityTweetFields%22%3Atrue%2C%22withBirdwatchNotes%22%3Atrue%2C%22withVoice%22%3Atrue%2C%22withV2Timeline%22%3Atrue%7D&features=%7B%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22verified_phone_label_enabled%22%3Afalse%2C%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%2C%22responsive_web_graphql_skip_user_profile_image_extensions_enabled%22%3Afalse%2C%22tweetypie_unmention_optimization_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Afalse%2C%22tweet_awards_web_tipping_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%2C%22responsive_web_media_download_video_enabled%22%3Afalse%2C%22responsive_web_enhance_cards_enabled%22%3Afalse%7D&fieldToggles=%7B%22withArticleRichContentState%22%3Afalse%7D',
  TweetDetailArticle:
    'https://twitter.com/i/api/graphql/GtcBtFhtQymrpxAs5MALVA/TweetDetail?variables=%7B%22focalTweetId%22%3A%221765884209527394325%22%2C%22with_rux_injections%22%3Atrue%2C%22rankingMode%22%3A%22Relevance%22%2C%22includePromotedContent%22%3Atrue%2C%22withCommunity%22%3Atrue%2C%22withQuickPromoteEligibilityTweetFields%22%3Atrue%2C%22withBirdwatchNotes%22%3Atrue%2C%22withVoice%22%3Atrue%7D&features=%7B%22profile_label_improvements_pcf_label_in_post_enabled%22%3Afalse%2C%22rweb_tipjar_consumption_enabled%22%3Atrue%2C%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22verified_phone_label_enabled%22%3Afalse%2C%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%2C%22responsive_web_graphql_skip_user_profile_image_extensions_enabled%22%3Afalse%2C%22premium_content_api_read_enabled%22%3Afalse%2C%22communities_web_enable_tweet_community_results_fetch%22%3Atrue%2C%22c9s_tweet_anatomy_moderator_badge_enabled%22%3Atrue%2C%22responsive_web_grok_analyze_button_fetch_trends_enabled%22%3Atrue%2C%22responsive_web_grok_analyze_post_followups_enabled%22%3Afalse%2C%22responsive_web_grok_share_attachment_enabled%22%3Atrue%2C%22articles_preview_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Atrue%2C%22tweet_awards_web_tipping_enabled%22%3Afalse%2C%22creator_subscriptions_quote_tweet_preview_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22rweb_video_timestamps_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%2C%22responsive_web_enhance_cards_enabled%22%3Afalse%7D&fieldToggles=%7B%22withArticleRichContentState%22%3Atrue%2C%22withArticlePlainText%22%3Afalse%2C%22withGrokAnalyze%22%3Afalse%2C%22withDisallowedReplyControls%22%3Afalse%7D',
  TweetResultByRestId:
    'https://twitter.com/i/api/graphql/DJS3BdhUhcaEpZ7B7irJDg/TweetResultByRestId?variables=%7B%22tweetId%22%3A%221237110546383724547%22%2C%22withCommunity%22%3Afalse%2C%22includePromotedContent%22%3Afalse%2C%22withVoice%22%3Afalse%7D&features=%7B%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22tweetypie_unmention_optimization_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Afalse%2C%22tweet_awards_web_tipping_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%2C%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22verified_phone_label_enabled%22%3Afalse%2C%22responsive_web_media_download_video_enabled%22%3Afalse%2C%22responsive_web_graphql_skip_user_profile_image_extensions_enabled%22%3Afalse%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%2C%22responsive_web_enhance_cards_enabled%22%3Afalse%7D',
  ListTweets:
    'https://twitter.com/i/api/graphql/whF0_KH1fCkdLLoyNPMoEw/ListLatestTweetsTimeline?variables=%7B%22listId%22%3A%221736495155002106192%22%2C%22count%22%3A20%7D&features=%7B%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22verified_phone_label_enabled%22%3Afalse%2C%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%2C%22responsive_web_graphql_skip_user_profile_image_extensions_enabled%22%3Afalse%2C%22c9s_tweet_anatomy_moderator_badge_enabled%22%3Atrue%2C%22tweetypie_unmention_optimization_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Afalse%2C%22tweet_awards_web_tipping_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22rweb_video_timestamps_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%2C%22responsive_web_media_download_video_enabled%22%3Afalse%2C%22responsive_web_enhance_cards_enabled%22%3Afalse%7D',
} as const;

export interface EndpointFieldInfo {
  /**
   * Request variables, used for providing arguments such as user IDs or result counts.
   */
  variables: Record<string, unknown>;

  /**
   * Request features, used for encoding feature flags into the request. These may either be
   * boolean values or numerically-encoded booleans (1 or 0). It is possible this may change
   * to include other representations of booleans as Twitter's backend evolves.
   */
  features: Record<string, unknown>;

  /**
   * Request field toggles, used for limiting how returned fields are represented. This is
   * rarely used.
   */
  fieldToggles: Record<string, unknown>;
}

type SomePartial<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

type EndpointVersion = string;
type EndpointName = string;
type EncodedVariables = string;
type EncodedFeatures = string;
type EncodedFieldToggles = string;

// TODO: Set up field-level Intellisense for the QraphQL parameters in these?
type EndpointFields<EndpointUrl> =
  EndpointUrl extends `https://twitter.com/i/api/graphql/${EndpointVersion}/${EndpointName}?variables=${EncodedVariables}&features=${EncodedFeatures}&fieldToggles=${EncodedFieldToggles}`
    ? EndpointFieldInfo
    : EndpointUrl extends `https://twitter.com/i/api/graphql/${EndpointVersion}/${EndpointName}?variables=${EncodedVariables}&features=${EncodedFeatures}`
      ? SomePartial<EndpointFieldInfo, 'fieldToggles'>
      : EndpointUrl extends `https://twitter.com/i/api/graphql/${EndpointVersion}/${EndpointName}?variables=${EncodedVariables}`
        ? SomePartial<EndpointFieldInfo, 'features' | 'fieldToggles'>
        : Partial<EndpointFieldInfo>;

export type ApiRequestInfo<EndpointUrl> = EndpointFields<EndpointUrl> & {
  /**
   * The URL, without any GraphQL query parameters.
   */
  url: string;

  /**
   * Converts the request back into a URL to be sent to the Twitter API.
   */
  toRequestUrl(): string;
};

/** Wrapper class for API request information. */
class ApiRequest<EndpointUrl> {
  url: string;
  variables?: Record<string, unknown> | undefined;
  features?: Record<string, unknown> | undefined;
  fieldToggles?: Record<string, unknown> | undefined;

  constructor(info: Omit<ApiRequestInfo<EndpointUrl>, 'toRequestUrl'>) {
    this.url = info.url;
    this.variables = info.variables;
    this.features = info.features;
    this.fieldToggles = info.fieldToggles;
  }

  toRequestUrl(): string {
    const params = new URLSearchParams();

    // Only include query parameters with values
    if (this.variables) {
      // Stringify with the query keys in sorted order like the Go package
      params.set('variables', stringify(this.variables) ?? '');
    }

    if (this.features) {
      params.set('features', stringify(this.features) ?? '');
    }

    if (this.fieldToggles) {
      params.set('fieldToggles', stringify(this.fieldToggles) ?? '');
    }

    return `${this.url}?${params.toString()}`;
  }
}

/**
 * Parses information from a Twitter API endpoint using an example request
 * URL against that endpoint. This can be used to extract GraphQL parameters
 * in order to easily reuse and/or override them later.
 * @param example An example of the endpoint to analyze.
 * @returns The parsed endpoint information.
 */
function parseEndpointExample<Endpoints, Endpoint extends string & keyof Endpoints>(
  example: Endpoint
): ApiRequestInfo<Endpoints[Endpoint]> {
  const { protocol, host, pathname, searchParams: query } = new URL(example);

  const base = `${protocol}//${host}${pathname}`;
  const variables = query.get('variables');
  const features = query.get('features');
  const fieldToggles = query.get('fieldToggles');

  return new ApiRequest<Endpoints[Endpoint]>({
    url: base,
    variables: variables ? JSON.parse(variables) : undefined,
    features: features ? JSON.parse(features) : undefined,
    fieldToggles: fieldToggles ? JSON.parse(fieldToggles) : undefined,
  } as Omit<ApiRequestInfo<Endpoints[Endpoint]>, 'toRequestUrl'>) as ApiRequestInfo<
    Endpoints[Endpoint]
  >;
}

type ApiRequestFactory<Endpoints> = {
  [Endpoint in keyof Endpoints as `create${string & Endpoint}Request`]: () => ApiRequestInfo<
    Endpoints[Endpoint]
  >;
};

function createApiRequestFactory<Endpoints extends Record<string, string>>(
  endpoints: Endpoints
): ApiRequestFactory<Endpoints> {
  type UntypedApiRequestFactory = ApiRequestFactory<Record<string, string>>;

  return Object.entries(endpoints)
    .map<UntypedApiRequestFactory>(([endpointName, endpointExample]) => {
      // Create a partial factory for only one endpoint
      return {
        [`create${endpointName}Request`]: () => {
          // Create a new instance on each invocation so that we can safely
          // mutate requests before sending them off
          return parseEndpointExample<Endpoints, any>(endpointExample);
        },
      };
    })
    .reduce((agg, next) => {
      // Merge all of our factories into one that includes every endpoint
      return Object.assign(agg, next);
    }) as ApiRequestFactory<Endpoints>;
}

export const apiRequestFactory = createApiRequestFactory(endpoints);
