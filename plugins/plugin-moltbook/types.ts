/**
 * Moltbook service settings from environment/character config
 */
export interface MoltbookSettings {
  /** Agent display name */
  agentName: string;
  /** Moltbook API token for social engagement */
  moltbookToken?: string;
  /** LLM API key (OpenRouter) */
  llmApiKey?: string;
  /** LLM base URL */
  llmBaseUrl?: string;
  /** LLM model identifier */
  model?: string;
  /** Agent personality/system prompt extension */
  personality?: string;
  /** Autonomy loop interval in ms */
  autonomyIntervalMs?: number;
  /** Maximum autonomy steps before stopping */
  autonomyMaxSteps?: number;
  /** Whether to run in autonomous mode */
  autonomousMode?: boolean;
}

/**
 * Moltbook post structure
 * Index signature allows compatibility with JsonValue
 */
export interface MoltbookPost {
  id: string;
  title: string;
  content?: string;
  body?: string;
  submolt?: { name: string; [key: string]: string };
  author?: { name: string; [key: string]: string };
  upvotes?: number;
  comment_count?: number;
  created_at?: string;
  [key: string]:
    | string
    | number
    | undefined
    | { name: string; [key: string]: string };
}

/**
 * Moltbook comment structure
 * Index signature allows compatibility with JsonValue
 */
export interface MoltbookComment {
  id: string;
  content: string;
  author?: { name: string; [key: string]: string };
  created_at?: string;
  parent_id?: string;
  [key: string]: string | undefined | { name: string; [key: string]: string };
}

/**
 * Moltbook submolt (subreddit equivalent) structure
 * Index signature allows compatibility with JsonValue
 */
export interface MoltbookSubmolt {
  id: string;
  name: string;
  description?: string;
  subscriber_count?: number;
  post_count?: number;
  created_at?: string;
  icon_url?: string;
  [key: string]: string | number | undefined;
}

/**
 * Event types emitted by the Moltbook service
 */
export const MoltbookEventTypes = {
  POST_CREATED: "moltbook.post.created",
  COMMENT_CREATED: "moltbook.comment.created",
  POSTS_BROWSED: "moltbook.posts.browsed",
  POST_READ: "moltbook.post.read",
  AUTONOMY_STEP_COMPLETED: "moltbook.autonomy.step.completed",
  AUTONOMY_STARTED: "moltbook.autonomy.started",
  AUTONOMY_STOPPED: "moltbook.autonomy.stopped",
} as const;

export type MoltbookEventType =
  (typeof MoltbookEventTypes)[keyof typeof MoltbookEventTypes];

/**
 * Payload for post events
 */
export interface MoltbookPostPayload {
  postId: string;
  submolt: string;
  title: string;
}

/**
 * Payload for comment events
 */
export interface MoltbookCommentPayload {
  commentId: string;
  postId: string;
  parentId?: string;
}

/**
 * Payload for autonomy step events
 */
export interface MoltbookAutonomyStepPayload {
  stepNumber: number;
  action: string;
  result: string;
  timestamp: string;
}

/**
 * Result type for API operations that can fail
 * Prevents silent failures by making errors explicit
 */
export type MoltbookResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; data?: undefined };

/** Type guard for failure branch so TS narrows when accessing .error */
export function isMoltbookFailure<T>(
  r: MoltbookResult<T>,
): r is { success: false; error: string } {
  return !r.success;
}

/**
 * Helper to create a successful result
 */
export function moltbookSuccess<T>(data: T): MoltbookResult<T> {
  return { success: true, data };
}

/**
 * Helper to create a failed result
 */
export function moltbookFailure<T>(error: string): MoltbookResult<T> {
  return { success: false, error };
}

/**
 * IMoltbookService interface for type-safe service access
 */
export interface IMoltbookService {
  /** Service type identifier */
  readonly serviceType: string;
  /** Post to Moltbook */
  moltbookPost(
    submolt: string,
    title: string,
    content: string,
  ): Promise<string>;
  /** Browse Moltbook posts - returns Result to distinguish empty from error */
  moltbookBrowse(
    submolt?: string,
    sort?: string,
  ): Promise<MoltbookResult<MoltbookPost[]>>;
  /** Comment on a Moltbook post */
  moltbookComment(postId: string, content: string): Promise<string>;
  /** Reply to a Moltbook comment */
  moltbookReply(
    postId: string,
    parentId: string,
    content: string,
  ): Promise<string>;
  /** Read a Moltbook post with comments */
  moltbookReadPost(
    postId: string,
  ): Promise<{ post: MoltbookPost; comments: MoltbookComment[] }>;
  /** List available submolts - returns Result to distinguish empty from error */
  moltbookListSubmolts(
    sort?: string,
  ): Promise<MoltbookResult<MoltbookSubmolt[]>>;
  /** Get submolt details - returns Result to distinguish not-found from error */
  moltbookGetSubmolt(
    submoltName: string,
  ): Promise<MoltbookResult<MoltbookSubmolt | null>>;
  /** Start autonomous loop */
  startAutonomyLoop(): void;
  /** Stop autonomous loop */
  stopAutonomyLoop(): void;
  /** Check if autonomy is running */
  isAutonomyRunning(): boolean;
}
