/**
 * Represents a Community that can host Spaces.
 */
export interface Community {
  id: string;
  name: string;
  rest_id: string;
}

/**
 * Represents the response structure for the CommunitySelectQuery.
 */
export interface CommunitySelectQueryResponse {
  data: {
    space_hostable_communities: Community[];
  };
  errors?: any[];
}

/**
 * Represents a Subtopic within a Category.
 */
export interface Subtopic {
  icon_url: string;
  name: string;
  topic_id: string;
}

/**
 * Represents a Category containing multiple Subtopics.
 */
export interface Category {
  icon: string;
  name: string;
  semantic_core_entity_id: string;
  subtopics: Subtopic[];
}

/**
 * Represents the data structure for BrowseSpaceTopics.
 */
export interface BrowseSpaceTopics {
  categories: Category[];
}

/**
 * Represents the response structure for the BrowseSpaceTopics query.
 */
export interface BrowseSpaceTopicsResponse {
  data: {
    browse_space_topics: BrowseSpaceTopics;
  };
  errors?: any[];
}

/**
 * Represents the result details of a Creator.
 */
export interface CreatorResult {
  __typename: string;
  id: string;
  rest_id: string;
  affiliates_highlighted_label: Record<string, any>;
  has_graduated_access: boolean;
  is_blue_verified: boolean;
  profile_image_shape: string;
  legacy: {
    following: boolean;
    can_dm: boolean;
    can_media_tag: boolean;
    created_at: string;
    default_profile: boolean;
    default_profile_image: boolean;
    description: string;
    entities: {
      description: {
        urls: any[];
      };
    };
    fast_followers_count: number;
    favourites_count: number;
    followers_count: number;
    friends_count: number;
    has_custom_timelines: boolean;
    is_translator: boolean;
    listed_count: number;
    location: string;
    media_count: number;
    name: string;
    needs_phone_verification: boolean;
    normal_followers_count: number;
    pinned_tweet_ids_str: string[];
    possibly_sensitive: boolean;
    profile_image_url_https: string;
    profile_interstitial_type: string;
    screen_name: string;
    statuses_count: number;
    translator_type: string;
    verified: boolean;
    want_retweets: boolean;
    withheld_in_countries: string[];
  };
  tipjar_settings: Record<string, any>;
}

/**
 * Represents user results within an Admin.
 */
export interface UserResults {
  rest_id: string;
  result: {
    __typename: string;
    identity_profile_labels_highlighted_label: Record<string, any>;
    is_blue_verified: boolean;
    legacy: Record<string, any>;
  };
}

/**
 * Represents an Admin participant in an Audio Space.
 */
export interface Admin {
  periscope_user_id: string;
  start: number;
  twitter_screen_name: string;
  display_name: string;
  avatar_url: string;
  is_verified: boolean;
  is_muted_by_admin: boolean;
  is_muted_by_guest: boolean;
  user_results: UserResults;
}

/**
 * Represents Participants in an Audio Space.
 */
export interface Participants {
  total: number;
  admins: Admin[];
  speakers: any[];
  listeners: any[];
}

/**
 * Represents Metadata of an Audio Space.
 */
export interface Metadata {
  rest_id: string;
  state: string;
  media_key: string;
  created_at: number;
  started_at: number;
  ended_at: string;
  updated_at: number;
  content_type: string;
  creator_results: {
    result: CreatorResult;
  };
  conversation_controls: number;
  disallow_join: boolean;
  is_employee_only: boolean;
  is_locked: boolean;
  is_muted: boolean;
  is_space_available_for_clipping: boolean;
  is_space_available_for_replay: boolean;
  narrow_cast_space_type: number;
  no_incognito: boolean;
  total_replay_watched: number;
  total_live_listeners: number;
  tweet_results: Record<string, any>;
  max_guest_sessions: number;
  max_admin_capacity: number;
}

/**
 * Represents Sharings within an Audio Space.
 */
export interface Sharings {
  items: any[];
  slice_info: Record<string, any>;
}

/**
 * Represents an Audio Space.
 */
export interface AudioSpace {
  metadata: Metadata;
  is_subscribed: boolean;
  participants: Participants;
  sharings: Sharings;
}

/**
 * Represents the response structure for the AudioSpaceById query.
 */
export interface AudioSpaceByIdResponse {
  data: {
    audioSpace: AudioSpace;
  };
  errors?: any[];
}

/**
 * Represents the variables required for the AudioSpaceById query.
 */
export interface AudioSpaceByIdVariables {
  id: string;
  isMetatagsQuery: boolean;
  withReplays: boolean;
  withListeners: boolean;
}

export interface LiveVideoSource {
  location: string;
  noRedirectPlaybackUrl: string;
  status: string;
  streamType: string;
}

export interface LiveVideoStreamStatus {
  source: LiveVideoSource;
  sessionId: string;
  chatToken: string;
  lifecycleToken: string;
  shareUrl: string;
  chatPermissionType: string;
}

export interface AuthenticatePeriscopeResponse {
  data: {
    authenticate_periscope: string;
  };
  errors?: any[];
}

export interface LoginTwitterTokenResponse {
  cookie: string;
  user: {
    class_name: string;
    id: string;
    created_at: string;
    is_beta_user: boolean;
    is_employee: boolean;
    is_twitter_verified: boolean;
    verified_type: number;
    is_bluebird_user: boolean;
    twitter_screen_name: string;
    username: string;
    display_name: string;
    description: string;
    profile_image_urls: {
      url: string;
      ssl_url: string;
      width: number;
      height: number;
    }[];
    twitter_id: string;
    initials: string;
    n_followers: number;
    n_following: number;
  };
  type: string;
}
