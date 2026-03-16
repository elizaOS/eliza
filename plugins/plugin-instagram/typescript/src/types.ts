/**
 * Type definitions for the Instagram plugin
 */

/** Instagram event types */
export enum InstagramEventType {
  /** Direct message received */
  MESSAGE_RECEIVED = "INSTAGRAM_MESSAGE_RECEIVED",
  /** Direct message sent */
  MESSAGE_SENT = "INSTAGRAM_MESSAGE_SENT",
  /** Comment received on a post */
  COMMENT_RECEIVED = "INSTAGRAM_COMMENT_RECEIVED",
  /** Like received on a post */
  LIKE_RECEIVED = "INSTAGRAM_LIKE_RECEIVED",
  /** New follower */
  FOLLOW_RECEIVED = "INSTAGRAM_FOLLOW_RECEIVED",
  /** Lost a follower */
  UNFOLLOW_RECEIVED = "INSTAGRAM_UNFOLLOW_RECEIVED",
  /** Story was viewed */
  STORY_VIEWED = "INSTAGRAM_STORY_VIEWED",
  /** Reply to story received */
  STORY_REPLY_RECEIVED = "INSTAGRAM_STORY_REPLY_RECEIVED",
}

/** Instagram media types */
export enum InstagramMediaType {
  /** Photo post */
  PHOTO = "photo",
  /** Video post */
  VIDEO = "video",
  /** Carousel/album post */
  CAROUSEL = "carousel",
  /** Reel */
  REEL = "reel",
  /** Story */
  STORY = "story",
  /** IGTV video */
  IGTV = "igtv",
}

/** Instagram user information */
export interface InstagramUser {
  /** User's primary key/ID */
  pk: number;
  /** Username */
  username: string;
  /** Full display name */
  fullName?: string;
  /** Profile picture URL */
  profilePicUrl?: string;
  /** Whether account is private */
  isPrivate: boolean;
  /** Whether account is verified */
  isVerified: boolean;
  /** Number of followers */
  followerCount?: number;
  /** Number of accounts following */
  followingCount?: number;
}

/** Instagram media information */
export interface InstagramMedia {
  /** Media's primary key/ID */
  pk: number;
  /** Type of media */
  mediaType: InstagramMediaType;
  /** Caption text */
  caption?: string;
  /** Media URL */
  url?: string;
  /** Thumbnail URL for videos */
  thumbnailUrl?: string;
  /** Number of likes */
  likeCount: number;
  /** Number of comments */
  commentCount: number;
  /** When media was posted */
  takenAt?: Date;
  /** User who posted */
  user?: InstagramUser;
}

/** Instagram direct message */
export interface InstagramMessage {
  /** Message ID */
  id: string;
  /** Thread/conversation ID */
  threadId: string;
  /** Message text */
  text?: string;
  /** When message was sent */
  timestamp: Date;
  /** User who sent the message */
  user: InstagramUser;
  /** Optional attached media */
  media?: InstagramMedia;
  /** Whether message has been seen */
  isSeen: boolean;
}

/** Instagram comment */
export interface InstagramComment {
  /** Comment's primary key */
  pk: number;
  /** Comment text */
  text: string;
  /** When comment was posted */
  createdAt: Date;
  /** User who commented */
  user: InstagramUser;
  /** Media the comment is on */
  mediaPk: number;
  /** If replying to another comment */
  replyToPk?: number;
}

/** Instagram DM thread */
export interface InstagramThread {
  /** Thread ID */
  id: string;
  /** Users in the thread */
  users: InstagramUser[];
  /** Last activity timestamp */
  lastActivityAt?: Date;
  /** Whether this is a group thread */
  isGroup: boolean;
  /** Thread title for groups */
  threadTitle?: string;
}

/** Instagram plugin configuration */
export interface InstagramConfig {
  /** Instagram username */
  username: string;
  /** Instagram password */
  password: string;
  /** Optional 2FA verification code */
  verificationCode?: string;
  /** Optional proxy URL */
  proxy?: string;
  /** Whether to auto-respond to DMs */
  autoRespondToDms?: boolean;
  /** Whether to auto-respond to comments */
  autoRespondToComments?: boolean;
  /** Polling interval in seconds */
  pollingInterval?: number;
}

/** Message payload for events */
export interface InstagramMessagePayload {
  /** Event type */
  eventType: InstagramEventType;
  /** Message data */
  message: InstagramMessage;
  /** Thread data */
  thread: InstagramThread;
}

/** Comment payload for events */
export interface InstagramCommentPayload {
  /** Event type */
  eventType: InstagramEventType;
  /** Comment data */
  comment: InstagramComment;
  /** Media that was commented on */
  media: InstagramMedia;
}

/** Follow payload for events */
export interface InstagramFollowPayload {
  /** Event type */
  eventType: InstagramEventType;
  /** User who followed/unfollowed */
  user: InstagramUser;
}

/** Story payload for events */
export interface InstagramStoryPayload {
  /** Event type */
  eventType: InstagramEventType;
  /** Story media */
  story: InstagramMedia;
  /** User who viewed/replied */
  user: InstagramUser;
  /** Reply text if applicable */
  replyText?: string;
}

/** Action context for Instagram actions */
export interface InstagramActionContext {
  /** Original message/event data */
  message: Record<string, unknown>;
  /** User ID */
  userId: number;
  /** Thread ID for DMs */
  threadId?: string;
  /** Media ID for comments */
  mediaId?: number;
  /** Current state */
  state: Record<string, unknown>;
}

/** Provider context */
export interface InstagramProviderContext {
  /** User ID */
  userId?: number;
  /** Thread ID */
  threadId?: string;
  /** Media ID */
  mediaId?: number;
  /** Room/conversation ID */
  roomId?: string;
}
