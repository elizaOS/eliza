import {
  ChannelType,
  type Character,
  type Content,
  createUniqueUuid,
  type EventPayload,
  type IAgentRuntime,
  type Memory,
  Service,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";

import {
  AUTONOMY_DEFAULTS,
  CONTENT_LIMITS,
  MOLTBOOK_SERVICE_NAME,
  URLS,
} from "./constants";
import { getMoltbookSettings, validateMoltbookSettings } from "./environment";
import {
  type IMoltbookService,
  type MoltbookComment,
  MoltbookEventTypes,
  type MoltbookPost,
  type MoltbookResult,
  isMoltbookFailure,
  type MoltbookSettings,
  type MoltbookSubmolt,
  moltbookFailure,
  moltbookSuccess,
} from "./types";

/**
 * MoltbookService - Social engagement service for the Moltbook platform
 * Enables agents to post, browse, and comment on Moltbook (Reddit for AI agents)
 */
export class MoltbookService extends Service implements IMoltbookService {
  static serviceType = MOLTBOOK_SERVICE_NAME;
  readonly serviceType = MOLTBOOK_SERVICE_NAME;
  capabilityDescription =
    "The agent can post, browse, and comment on Moltbook - a Reddit-style social platform for AI agents";

  private settings!: MoltbookSettings;

  // Memory for autonomy
  private memory: string[] = [];

  // Autonomy loop
  private autonomyRunning = false;
  private autonomyStepCount = 0;
  private autonomyTimeout: ReturnType<typeof setTimeout> | null = null;

  // Track initialization state - prevents LARP where service appears working but isn't
  private _initialized = false;
  private _initializationError: string | null = null;

  character!: Character;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.settings = getMoltbookSettings(runtime);
      this.character = runtime.character;
    }
  }

  /**
   * Check if service is properly initialized
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Get initialization error if any
   */
  get initializationError(): string | null {
    return this._initializationError;
  }

  /**
   * Static factory method to create and initialize the service
   */
  static async start(runtime: IAgentRuntime): Promise<MoltbookService> {
    const service = new MoltbookService(runtime);
    const success = await service.initialize();
    if (!success) {
      runtime.logger.error(
        `Moltbook service failed to initialize: ${service.initializationError}`,
      );
    }
    return service;
  }

  /**
   * Initialize the Moltbook service
   * Returns true if initialization succeeded, false otherwise
   */
  private async initialize(): Promise<boolean> {
    const validation = validateMoltbookSettings(this.settings);

    // Log warnings
    for (const warning of validation.warnings) {
      this.runtime.logger.warn(warning);
    }

    if (!validation.valid) {
      this._initializationError = validation.errors.join("; ");
      this.runtime.logger.error(
        `Moltbook service initialization failed: ${this._initializationError}`,
      );
      return false;
    }

    try {
      this.runtime.logger.info(
        `Moltbook service started for ${this.settings.agentName}`,
      );
      this.runtime.logger.info(`Moltbook API: ${URLS.moltbook}`);
      this.runtime.logger.info(
        `Token configured: ${this.settings.moltbookToken ? "yes" : "no"}`,
      );

      // Register send handler for moltbook source
      this.runtime.registerSendHandler(
        "moltbook",
        this.handleSendMessage.bind(this),
      );

      // Start autonomy loop if enabled
      if (this.settings.autonomousMode) {
        this.startAutonomyLoop();
      }

      this._initialized = true;
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this._initializationError = errorMsg;
      this.runtime.logger.error(
        `Failed to start Moltbook service: ${errorMsg}`,
      );
      return false;
    }
  }

  /**
   * Stop the Moltbook service
   */
  async stop(): Promise<void> {
    this.stopAutonomyLoop();
    this.runtime.logger.info("Moltbook service stopped");
  }

  /**
   * Post to Moltbook
   */
  async moltbookPost(
    submolt: string,
    title: string,
    content: string,
  ): Promise<string> {
    if (!this.settings.moltbookToken) {
      throw new Error("MOLTBOOK_TOKEN not set - cannot create posts");
    }

    // Validate content lengths
    if (title.length > CONTENT_LIMITS.maxTitleLength) {
      throw new Error(
        `Title exceeds maximum length of ${CONTENT_LIMITS.maxTitleLength} characters`,
      );
    }
    if (content.length > CONTENT_LIMITS.maxContentLength) {
      throw new Error(
        `Content exceeds maximum length of ${CONTENT_LIMITS.maxContentLength} characters`,
      );
    }

    try {
      const response = await fetch(`${URLS.moltbook}/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.moltbookToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ submolt, title, content }),
      });

      const data = (await response.json()) as {
        error?: string;
        post?: { id: string };
      };
      if (!response.ok) {
        throw new Error(data.error || JSON.stringify(data));
      }

      this.runtime.emitEvent(
        MoltbookEventTypes.POST_CREATED as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload,
      );

      this.runtime.logger.info(`Posted to Moltbook: ${title} in r/${submolt}`);
      return data.post?.id || "success";
    } catch (error) {
      this.runtime.logger.error(`Failed to post to Moltbook: ${error}`);
      throw error;
    }
  }

  /**
   * Browse Moltbook posts
   * Returns a Result type so callers can distinguish "no posts" from "API error"
   */
  async moltbookBrowse(
    submolt?: string,
    sort = "hot",
  ): Promise<MoltbookResult<MoltbookPost[]>> {
    try {
      const url = submolt
        ? `${URLS.moltbook}/submolts/${submolt}/feed?sort=${sort}&limit=${CONTENT_LIMITS.defaultBrowseLimit}`
        : `${URLS.moltbook}/posts?sort=${sort}&limit=${CONTENT_LIMITS.defaultBrowseLimit}`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Add auth header if token is available (may get more results)
      if (this.settings.moltbookToken) {
        headers.Authorization = `Bearer ${this.settings.moltbookToken}`;
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        const errorText = await response.text();
        this.runtime.logger.error(
          `Moltbook API error (${response.status}): ${errorText}`,
        );
        return moltbookFailure(
          `API returned ${response.status}: ${errorText.slice(0, 100)}`,
        );
      }

      const data = (await response.json()) as { posts?: MoltbookPost[] };
      const posts = data.posts || [];

      this.runtime.emitEvent(
        MoltbookEventTypes.POSTS_BROWSED as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload,
      );

      return moltbookSuccess(posts);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.runtime.logger.error(`Failed to browse Moltbook: ${errorMsg}`);
      return moltbookFailure(errorMsg);
    }
  }

  /**
   * Comment on a Moltbook post
   */
  async moltbookComment(postId: string, content: string): Promise<string> {
    if (!this.settings.moltbookToken) {
      throw new Error("MOLTBOOK_TOKEN not set - cannot create comments");
    }

    if (content.length > CONTENT_LIMITS.maxCommentLength) {
      throw new Error(
        `Comment exceeds maximum length of ${CONTENT_LIMITS.maxCommentLength} characters`,
      );
    }

    try {
      const response = await fetch(
        `${URLS.moltbook}/posts/${postId}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.settings.moltbookToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content }),
        },
      );

      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error || JSON.stringify(data));
      }

      this.runtime.emitEvent(
        MoltbookEventTypes.COMMENT_CREATED as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload,
      );

      this.runtime.logger.info(`Commented on Moltbook post ${postId}`);
      return data.id || "success";
    } catch (error) {
      this.runtime.logger.error(`Failed to comment on Moltbook: ${error}`);
      throw error;
    }
  }

  /**
   * Reply to a Moltbook comment
   */
  async moltbookReply(
    postId: string,
    parentId: string,
    content: string,
  ): Promise<string> {
    if (!this.settings.moltbookToken) {
      throw new Error("MOLTBOOK_TOKEN not set - cannot create replies");
    }

    if (content.length > CONTENT_LIMITS.maxCommentLength) {
      throw new Error(
        `Reply exceeds maximum length of ${CONTENT_LIMITS.maxCommentLength} characters`,
      );
    }

    try {
      const response = await fetch(
        `${URLS.moltbook}/posts/${postId}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.settings.moltbookToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content, parent_id: parentId }),
        },
      );

      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error || JSON.stringify(data));
      }

      this.runtime.emitEvent(
        MoltbookEventTypes.COMMENT_CREATED as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload,
      );

      this.runtime.logger.info(
        `Replied to comment ${parentId} on post ${postId}`,
      );
      return data.id || "success";
    } catch (error) {
      this.runtime.logger.error(`Failed to reply on Moltbook: ${error}`);
      throw error;
    }
  }

  /**
   * Read a Moltbook post with comments
   */
  async moltbookReadPost(
    postId: string,
  ): Promise<{ post: MoltbookPost; comments: MoltbookComment[] }> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.settings.moltbookToken) {
        headers.Authorization = `Bearer ${this.settings.moltbookToken}`;
      }

      const response = await fetch(`${URLS.moltbook}/posts/${postId}`, {
        headers,
      });
      const data = (await response.json()) as {
        post?: MoltbookPost;
        comments?: MoltbookComment[];
      };

      if (!data.post) {
        throw new Error("Post not found");
      }

      this.runtime.emitEvent(
        MoltbookEventTypes.POST_READ as string,
        {
          runtime: this.runtime,
          source: "moltbook",
        } as EventPayload,
      );

      return {
        post: data.post,
        comments: data.comments || [],
      };
    } catch (error) {
      this.runtime.logger.error(`Failed to read Moltbook post: ${error}`);
      throw error;
    }
  }

  /**
   * List available submolts
   * Returns a Result type so callers can distinguish "no submolts" from "API error"
   */
  async moltbookListSubmolts(
    sort = "popular",
  ): Promise<MoltbookResult<MoltbookSubmolt[]>> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.settings.moltbookToken) {
        headers.Authorization = `Bearer ${this.settings.moltbookToken}`;
      }

      const response = await fetch(
        `${URLS.moltbook}/submolts?sort=${sort}&limit=20`,
        { headers },
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.runtime.logger.error(
          `Moltbook API error (${response.status}): ${errorText}`,
        );
        return moltbookFailure(
          `API returned ${response.status}: ${errorText.slice(0, 100)}`,
        );
      }

      const data = (await response.json()) as { submolts?: MoltbookSubmolt[] };
      return moltbookSuccess(data.submolts || []);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.runtime.logger.error(`Failed to list submolts: ${errorMsg}`);
      return moltbookFailure(errorMsg);
    }
  }

  /**
   * Get details about a specific submolt
   * Returns a Result type so callers can distinguish "not found" from "API error"
   */
  async moltbookGetSubmolt(
    submoltName: string,
  ): Promise<MoltbookResult<MoltbookSubmolt | null>> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.settings.moltbookToken) {
        headers.Authorization = `Bearer ${this.settings.moltbookToken}`;
      }

      const response = await fetch(`${URLS.moltbook}/submolts/${submoltName}`, {
        headers,
      });

      if (response.status === 404) {
        // Not found is a valid result, not an error
        return moltbookSuccess(null);
      }

      if (!response.ok) {
        const errorText = await response.text();
        this.runtime.logger.error(
          `Moltbook API error (${response.status}): ${errorText}`,
        );
        return moltbookFailure(
          `API returned ${response.status}: ${errorText.slice(0, 100)}`,
        );
      }

      const data = (await response.json()) as { submolt?: MoltbookSubmolt };
      return moltbookSuccess(data.submolt || null);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.runtime.logger.error(
        `Failed to get submolt ${submoltName}: ${errorMsg}`,
      );
      return moltbookFailure(errorMsg);
    }
  }

  /**
   * Handle send message from runtime (for moltbook source)
   */
  private async handleSendMessage(
    _runtime: IAgentRuntime,
    _target: TargetInfo,
    content: Content,
  ): Promise<void> {
    // This handler can be used for automated posting from the runtime
    // Access dynamic properties via index signature since Content allows arbitrary keys
    const metadata = content.metadata as
      | Record<string, string | undefined>
      | undefined;
    const postId = metadata?.postId;
    const submolt = metadata?.submolt;
    const title = metadata?.title;
    const text = content.text;

    if (text && postId) {
      // It's a comment
      await this.moltbookComment(postId, text);
    } else if (text && submolt && title) {
      // It's a new post
      await this.moltbookPost(submolt, title, text);
    }
  }

  // ==================== AUTONOMY LOOP ====================

  /**
   * Check if autonomy loop is running
   */
  isAutonomyRunning(): boolean {
    return this.autonomyRunning;
  }

  /**
   * Start the autonomous agent loop
   */
  startAutonomyLoop(): void {
    if (this.autonomyRunning) {
      this.runtime.logger.warn("Autonomy loop already running");
      return;
    }

    this.autonomyRunning = true;
    this.autonomyStepCount = 0;

    this.runtime.emitEvent(
      MoltbookEventTypes.AUTONOMY_STARTED as string,
      {
        runtime: this.runtime,
        source: "moltbook",
      } as EventPayload,
    );

    this.runtime.logger.info("Moltbook autonomy loop started");
    this.runAutonomyStep();
  }

  /**
   * Stop the autonomous agent loop
   */
  stopAutonomyLoop(): void {
    if (!this.autonomyRunning) return;

    this.autonomyRunning = false;
    if (this.autonomyTimeout) {
      clearTimeout(this.autonomyTimeout);
      this.autonomyTimeout = null;
    }

    this.runtime.emitEvent(
      MoltbookEventTypes.AUTONOMY_STOPPED as string,
      {
        runtime: this.runtime,
        source: "moltbook",
      } as EventPayload,
    );

    this.runtime.logger.info("Moltbook autonomy loop stopped");
  }

  /**
   * Structured action types for autonomy loop
   */
  private readonly AUTONOMY_ACTIONS = {
    POST: "POST",
    COMMENT: "COMMENT",
    BROWSE: "BROWSE",
    WAIT: "WAIT",
  } as const;

  /**
   * Parse LLM response to extract structured action
   */
  private parseAutonomyAction(response: string): {
    action: string;
    submolt?: string;
    title?: string;
    content?: string;
    postId?: string;
  } | null {
    // Look for JSON block in response
    const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]) as {
          action: string;
          submolt?: string;
          title?: string;
          content?: string;
          postId?: string;
        };
      } catch {
        this.runtime.logger.warn("Failed to parse JSON action from response");
      }
    }

    // Fallback: try to parse entire response as JSON
    try {
      const parsed = JSON.parse(response) as {
        action: string;
        submolt?: string;
        title?: string;
        content?: string;
        postId?: string;
      };
      if (parsed.action) return parsed;
    } catch {
      // Not JSON, continue to pattern matching
    }

    // Pattern matching fallback for natural language responses
    const lowerResponse = response.toLowerCase();
    if (
      lowerResponse.includes("create a post") ||
      lowerResponse.includes("write a post") ||
      lowerResponse.includes("post about")
    ) {
      return { action: this.AUTONOMY_ACTIONS.POST };
    }
    if (
      lowerResponse.includes("comment on") ||
      lowerResponse.includes("reply to")
    ) {
      return { action: this.AUTONOMY_ACTIONS.COMMENT };
    }
    if (
      lowerResponse.includes("browse") ||
      lowerResponse.includes("check posts")
    ) {
      return { action: this.AUTONOMY_ACTIONS.BROWSE };
    }

    return { action: this.AUTONOMY_ACTIONS.WAIT };
  }

  /**
   * Execute one autonomy step - ACTUALLY performs actions, not just thinks about them
   */
  private async runAutonomyStep(): Promise<void> {
    if (!this.autonomyRunning) return;

    // Check step limit
    if (
      this.settings.autonomyMaxSteps &&
      this.autonomyStepCount >= this.settings.autonomyMaxSteps
    ) {
      this.runtime.logger.info(
        `Reached max autonomy steps (${this.settings.autonomyMaxSteps})`,
      );
      this.stopAutonomyLoop();
      return;
    }

    this.autonomyStepCount++;
    const stepNum = this.autonomyStepCount;

    try {
      // Browse recent posts for context
      const browseResult = await this.moltbookBrowse(undefined, "hot");
      const recentPosts = browseResult.success ? browseResult.data : [];
      const postsContext = recentPosts
        .slice(0, 5)
        .map(
          (p) =>
            `- [id:${p.id}] [r/${p.submolt?.name || "general"}] "${p.title}" by ${p.author?.name || "anon"} (${p.upvotes || 0} votes, ${p.comment_count || 0} comments)`,
        )
        .join("\n");

      // Create decision prompt with STRUCTURED OUTPUT requirement
      const decisionPrompt = `You are ${this.character.name}, an autonomous AI agent on Moltbook (Reddit for AI agents).

YOUR PERSONALITY:
${Array.isArray(this.character.bio) ? this.character.bio.join("\n") : this.character.bio || "A friendly AI agent"}

CURRENT CONTEXT:
- Step: ${stepNum}
- Recent posts on Moltbook:
${postsContext || "(no recent posts)"}

YOUR RECENT MEMORY:
${this.memory.slice(-5).join("\n") || "(empty)"}

DECIDE what action to take. You MUST respond with a JSON object in a code block.

Available actions:
1. POST - Create a new post (requires: submolt, title, content)
2. COMMENT - Comment on an existing post (requires: postId, content)
3. BROWSE - Browse a specific submolt (optional: submolt)
4. WAIT - Do nothing this cycle

RESPOND WITH EXACTLY THIS FORMAT:
\`\`\`json
{
  "action": "POST|COMMENT|BROWSE|WAIT",
  "submolt": "submolt name (for POST/BROWSE)",
  "title": "post title (for POST only)",
  "content": "post body or comment text",
  "postId": "post ID (for COMMENT only)",
  "reasoning": "brief explanation of why you chose this action"
}
\`\`\`

Be creative but stay in character. If you POST, make it engaging and relevant to your personality.`;

      const roomId = createUniqueUuid(this.runtime, "moltbook-autonomy");
      const entityId = createUniqueUuid(this.runtime, "autonomy-system");

      const memory: Memory = {
        id: stringToUuid(`autonomy-${stepNum}`) as UUID,
        entityId,
        roomId,
        agentId: this.runtime.agentId,
        content: {
          text: decisionPrompt,
          source: "moltbook",
          channelType: ChannelType.DM,
          metadata: { isAutonomous: true },
        },
        createdAt: Date.now(),
      };

      // Get LLM decision
      if (!this.runtime.messageService) {
        this.runtime.logger.error(
          "[MoltbookService] messageService not available",
        );
        return;
      }

      const result = await this.runtime.messageService.handleMessage(
        this.runtime,
        memory,
      );

      const responseText = result?.responseContent?.text || "";
      const parsedAction = this.parseAutonomyAction(responseText);

      if (!parsedAction) {
        this.memory.push(`Step ${stepNum}: Failed to parse action from LLM`);
        this.runtime.logger.warn(
          `Autonomy step ${stepNum}: Could not parse action`,
        );
        return;
      }

      // ACTUALLY EXECUTE THE ACTION
      let actionResult = "";

      switch (parsedAction.action.toUpperCase()) {
        case this.AUTONOMY_ACTIONS.POST: {
          if (
            !this.settings.moltbookToken ||
            !parsedAction.title ||
            !parsedAction.content
          ) {
            actionResult = "POST skipped: missing token, title, or content";
            this.runtime.logger.info(
              `Autonomy step ${stepNum}: ${actionResult}`,
            );
          } else {
            const submolt = parsedAction.submolt || "iq";
            try {
              const postId = await this.moltbookPost(
                submolt,
                parsedAction.title,
                parsedAction.content,
              );
              actionResult = `POSTED to r/${submolt}: "${parsedAction.title}" (id: ${postId})`;
              this.runtime.logger.info(
                `Autonomy step ${stepNum}: ${actionResult}`,
              );
            } catch (err) {
              actionResult = `POST failed: ${err instanceof Error ? err.message : String(err)}`;
              this.runtime.logger.error(
                `Autonomy step ${stepNum}: ${actionResult}`,
              );
            }
          }
          break;
        }

        case this.AUTONOMY_ACTIONS.COMMENT: {
          if (
            !this.settings.moltbookToken ||
            !parsedAction.postId ||
            !parsedAction.content
          ) {
            actionResult = "COMMENT skipped: missing token, postId, or content";
            this.runtime.logger.info(
              `Autonomy step ${stepNum}: ${actionResult}`,
            );
          } else {
            try {
              const commentId = await this.moltbookComment(
                parsedAction.postId,
                parsedAction.content,
              );
              actionResult = `COMMENTED on post ${parsedAction.postId} (comment id: ${commentId})`;
              this.runtime.logger.info(
                `Autonomy step ${stepNum}: ${actionResult}`,
              );
            } catch (err) {
              actionResult = `COMMENT failed: ${err instanceof Error ? err.message : String(err)}`;
              this.runtime.logger.error(
                `Autonomy step ${stepNum}: ${actionResult}`,
              );
            }
          }
          break;
        }

        case this.AUTONOMY_ACTIONS.BROWSE: {
          const submolt = parsedAction.submolt;
          const browseRes = await this.moltbookBrowse(submolt, "hot");
          if (isMoltbookFailure(browseRes)) {
            actionResult = `BROWSE failed: ${browseRes.error}`;
          } else {
            actionResult = `BROWSED ${submolt ? `r/${submolt}` : "front page"}: found ${browseRes.data.length} posts`;
          }
          this.runtime.logger.info(`Autonomy step ${stepNum}: ${actionResult}`);
          break;
        }

        default: {
          // WAIT or any unknown action
          actionResult = "WAITED this cycle";
          this.runtime.logger.info(`Autonomy step ${stepNum}: ${actionResult}`);
          break;
        }
      }

      // Store the actual result in memory (not just the thought)
      this.memory.push(`Step ${stepNum}: ${actionResult}`);

      this.runtime.emitEvent(
        MoltbookEventTypes.AUTONOMY_STEP_COMPLETED as string,
        {
          runtime: this.runtime,
          source: "moltbook",
          stepNumber: stepNum,
          action: parsedAction.action,
          result: actionResult,
        } as EventPayload,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.runtime.logger.error(`Autonomy step ${stepNum} error: ${errorMsg}`);
      this.memory.push(`Step ${stepNum}: ERROR - ${errorMsg}`);
    }

    // Schedule next step with configured delay (plus some jitter)
    if (this.autonomyRunning) {
      const baseDelay =
        this.settings.autonomyIntervalMs || AUTONOMY_DEFAULTS.minIntervalMs;
      const jitter = Math.random() * 10000; // 0-10 seconds jitter
      const delay = baseDelay + jitter;

      this.autonomyTimeout = setTimeout(() => this.runAutonomyStep(), delay);
    }
  }

  /**
   * Add a thought to memory
   */
  addThought(thought: string): void {
    this.memory.push(thought);
    // Keep memory bounded
    if (this.memory.length > 100) {
      this.memory = this.memory.slice(-50);
    }
  }
}
