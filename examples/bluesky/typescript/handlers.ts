/**
 * Bluesky Event Handlers
 *
 * These handlers process Bluesky events through the FULL elizaOS pipeline:
 * - State composition with providers (CHARACTER, RECENT_MESSAGES, ACTIONS, etc.)
 * - shouldRespond evaluation
 * - Action planning and execution
 * - Response generation via messageHandlerTemplate
 * - Evaluators
 *
 * This is the canonical way to handle messages in elizaOS - NO bypassing the pipeline.
 */

import {
  ChannelType,
  type Content,
  createMessageMemory,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";

const BLUESKY_SERVICE_NAME = "bluesky";
const BLUESKY_WORLD_ID = stringToUuid("bluesky-world");

// ============================================================================
// BlueSky Types (inlined to avoid circular dependencies)
// ============================================================================

interface BlueSkyProfile {
  did: string;
  handle: string;
  displayName?: string;
}

interface BlueSkyNotification {
  uri: string;
  cid: string;
  author: BlueSkyProfile;
  reason: string;
  record: Record<string, unknown>;
  isRead: boolean;
  indexedAt: string;
}

interface BlueSkyPost {
  uri: string;
  cid: string;
}

interface BlueSkyNotificationEventPayload {
  runtime: IAgentRuntime;
  source: string;
  notification: BlueSkyNotification;
}

interface BlueSkyCreatePostEventPayload {
  runtime: IAgentRuntime;
  source: string;
  automated: boolean;
}

interface BlueSkyPostService {
  createPost(
    text: string,
    replyTo?: { uri: string; cid: string },
  ): Promise<BlueSkyPost>;
}

interface BlueSkyServiceType {
  getPostService(agentId: UUID): BlueSkyPostService | undefined;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a unique UUID by combining base ID with agent ID
 * This ensures unique IDs per agent for the same external ID
 */
function createUniqueUuid(runtime: IAgentRuntime, baseId: string): UUID {
  if (baseId === runtime.agentId) {
    return runtime.agentId;
  }
  const combinedString = `${baseId}:${runtime.agentId}`;
  return stringToUuid(combinedString);
}

/**
 * Get the BlueSky service from the runtime
 */
function getBlueSkyService(runtime: IAgentRuntime): BlueSkyServiceType | null {
  const service = runtime.getService(BLUESKY_SERVICE_NAME);
  return service as BlueSkyServiceType | null;
}

/**
 * Check if the runtime has a messageService available
 */
function hasMessageService(runtime: IAgentRuntime): boolean {
  return (
    runtime.messageService !== null &&
    typeof runtime.messageService?.handleMessage === "function"
  );
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handler for bluesky.mention_received and bluesky.should_respond events
 *
 * This processes incoming mentions through the FULL elizaOS pipeline:
 * 1. Creates a proper Memory using createMessageMemory()
 * 2. Ensures connection/room exists
 * 3. Calls messageService.handleMessage() which runs:
 *    - State composition with all registered providers
 *    - shouldRespond evaluation (respects CHECK_SHOULD_RESPOND setting)
 *    - Action planning (if enabled)
 *    - Response generation via the full messageHandlerTemplate
 *    - Evaluator execution
 * 4. The callback posts the response to Bluesky
 */
export async function handleMentionReceived(
  payload: BlueSkyNotificationEventPayload,
): Promise<void> {
  const { runtime, notification } = payload;

  // Skip if not a mention or reply
  if (notification.reason !== "mention" && notification.reason !== "reply") {
    runtime.logger.debug(
      { reason: notification.reason },
      "Skipping non-mention notification",
    );
    return;
  }

  // Extract the post text from the notification record
  const record = notification.record as { text?: string };
  const mentionText = record.text || "";

  if (!mentionText.trim()) {
    runtime.logger.debug("Empty mention text, skipping");
    return;
  }

  runtime.logger.info(
    {
      src: "bluesky",
      handle: notification.author.handle,
      reason: notification.reason,
      text: mentionText.substring(0, 50),
    },
    "Processing Bluesky mention through elizaOS pipeline",
  );

  // Create unique IDs for this conversation
  const entityId = createUniqueUuid(runtime, notification.author.did);
  const roomId = createUniqueUuid(runtime, notification.uri);

  // Ensure the connection exists (creates entity, room, world if needed)
  await runtime.ensureConnection({
    entityId,
    roomId,
    userName: notification.author.handle,
    name: notification.author.displayName || notification.author.handle,
    source: "bluesky",
    channelId: notification.uri,
    type: ChannelType.GROUP, // Bluesky posts are public
    worldId: BLUESKY_WORLD_ID,
    worldName: "Bluesky",
  });

  // Create the incoming message memory using the canonical helper
  // This creates a properly formatted MessageMemory with all required fields
  const message = createMessageMemory({
    id: stringToUuid(uuidv4()) as UUID,
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: mentionText,
      source: "bluesky",
      // Include mention context so shouldRespond knows this is a direct mention
      mentionContext: {
        isMention: notification.reason === "mention",
        isReply: notification.reason === "reply",
        isThread: false,
        mentionType:
          notification.reason === "mention" ? "platform_mention" : "reply",
      },
      // Store Bluesky-specific metadata for the callback
      metadata: {
        uri: notification.uri,
        cid: notification.cid,
        authorDid: notification.author.did,
        authorHandle: notification.author.handle,
        platform: "bluesky",
      },
    },
  });

  // Get the BlueSky service for posting replies
  const blueskyService = getBlueSkyService(runtime);
  if (!blueskyService) {
    runtime.logger.error("BlueSky service not available, cannot post reply");
    return;
  }

  const postService = blueskyService.getPostService(runtime.agentId);
  if (!postService) {
    runtime.logger.error("BlueSky post service not available");
    return;
  }

  /**
   * Callback function called by messageService when a response is generated
   * This is where we post the response to Bluesky
   */
  const callback: HandlerCallback = async (
    content: Content,
  ): Promise<Memory[]> => {
    // Check if response is targeted elsewhere
    if (
      content.target &&
      typeof content.target === "string" &&
      content.target.toLowerCase() !== "bluesky"
    ) {
      runtime.logger.debug(
        { target: content.target },
        "Response targeted elsewhere, skipping Bluesky post",
      );
      return [];
    }

    // Skip if no text to post
    if (!content.text?.trim()) {
      runtime.logger.debug("No text in response, skipping Bluesky post");
      return [];
    }

    // Truncate to Bluesky's limit (300 chars) if needed
    let responseText = content.text.trim();
    if (responseText.length > 300) {
      responseText = `${responseText.substring(0, 297)}...`;
    }

    try {
      // Post the reply to Bluesky
      const post = await postService.createPost(responseText, {
        uri: notification.uri,
        cid: notification.cid,
      });

      runtime.logger.info(
        {
          src: "bluesky",
          uri: post.uri,
          replyTo: notification.author.handle,
        },
        "Posted reply to Bluesky",
      );

      // Create memory for the response
      const responseMemory: Memory = {
        id: stringToUuid(uuidv4()) as UUID,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId,
        content: {
          ...content,
          text: responseText,
          inReplyTo: message.id,
          metadata: {
            uri: post.uri,
            cid: post.cid,
            platform: "bluesky",
          },
        },
        createdAt: Date.now(),
      };

      return [responseMemory];
    } catch (error) {
      runtime.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to post reply to Bluesky",
      );
      return [];
    }
  };

  // Process through the FULL elizaOS pipeline
  if (!hasMessageService(runtime)) {
    runtime.logger.error(
      "MessageService not available - cannot process through elizaOS pipeline",
    );
    return;
  }

  try {
    const result = await runtime.messageService?.handleMessage(
      runtime,
      message,
      callback,
    );

    if (result) {
      runtime.logger.debug(
        {
          didRespond: result.didRespond,
          mode: result.mode,
          actionsExecuted: result.state?.data?.actionResults?.length || 0,
        },
        "elizaOS pipeline completed",
      );
    }
  } catch (error) {
    runtime.logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Error processing message through elizaOS pipeline",
    );
  }
}

/**
 * Handler for bluesky.should_respond events
 * Routes to handleMentionReceived for full pipeline processing
 */
export async function handleShouldRespond(
  payload: BlueSkyNotificationEventPayload,
): Promise<void> {
  const { notification } = payload;

  // Process mentions and replies through the full pipeline
  if (notification.reason === "mention" || notification.reason === "reply") {
    await handleMentionReceived(payload);
  }
}

/**
 * Handler for bluesky.create_post events (automated posting)
 *
 * For automated posts, we use the POST_GENERATED event flow which also
 * goes through the elizaOS pipeline for content generation.
 */
export async function handleCreatePost(
  payload: BlueSkyCreatePostEventPayload,
): Promise<void> {
  const { runtime, automated } = payload;

  if (!automated) {
    return;
  }

  runtime.logger.info("Generating automated Bluesky post via elizaOS pipeline");

  // Get the BlueSky service
  const blueskyService = getBlueSkyService(runtime);
  if (!blueskyService) {
    runtime.logger.error("BlueSky service not available for automated posting");
    return;
  }

  const postService = blueskyService.getPostService(runtime.agentId);
  if (!postService) {
    runtime.logger.error("BlueSky post service not available");
    return;
  }

  // Create a room for automated posts
  const roomId = createUniqueUuid(runtime, "bluesky-automated-posts");

  await runtime.ensureConnection({
    entityId: runtime.agentId,
    roomId,
    userName: runtime.character.name,
    name: runtime.character.name,
    source: "bluesky",
    channelId: "automated-posts",
    type: ChannelType.SELF,
    worldId: BLUESKY_WORLD_ID,
    worldName: "Bluesky",
  });

  // Create a trigger message for post generation
  // The elizaOS pipeline will compose state and generate appropriate content
  const triggerMessage = createMessageMemory({
    id: stringToUuid(uuidv4()) as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: "Generate a new post for Bluesky",
      source: "bluesky",
      metadata: {
        isAutomatedPostTrigger: true,
        platform: "bluesky",
        maxLength: 300,
      },
    },
  });

  const callback: HandlerCallback = async (
    content: Content,
  ): Promise<Memory[]> => {
    if (!content.text?.trim()) {
      runtime.logger.debug("No text generated for automated post");
      return [];
    }

    // Truncate to Bluesky's limit
    let postText = content.text.trim();
    if (postText.length > 300) {
      postText = `${postText.substring(0, 297)}...`;
    }

    try {
      const post = await postService.createPost(postText);

      runtime.logger.info(
        { src: "bluesky", uri: post.uri },
        "Created automated post on Bluesky",
      );

      const postMemory: Memory = {
        id: stringToUuid(uuidv4()) as UUID,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId,
        content: {
          ...content,
          text: postText,
          metadata: {
            uri: post.uri,
            cid: post.cid,
            platform: "bluesky",
            automated: true,
          },
        },
        createdAt: Date.now(),
      };

      return [postMemory];
    } catch (error) {
      runtime.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to create automated post",
      );
      return [];
    }
  };

  if (!hasMessageService(runtime)) {
    runtime.logger.error("MessageService not available for automated posting");
    return;
  }

  try {
    await runtime.messageService?.handleMessage(
      runtime,
      triggerMessage,
      callback,
    );
  } catch (error) {
    runtime.logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Error generating automated post",
    );
  }
}

/**
 * Register all Bluesky event handlers with the runtime
 *
 * These handlers integrate with the BlueSky plugin's event system:
 * - bluesky.mention_received: When the agent is mentioned in a post
 * - bluesky.should_respond: Trigger to evaluate and respond to a notification
 * - bluesky.create_post: Trigger for automated post generation
 */
export function registerBlueskyHandlers(runtime: IAgentRuntime): void {
  runtime.registerEvent("bluesky.mention_received", handleMentionReceived);
  runtime.registerEvent("bluesky.should_respond", handleShouldRespond);
  runtime.registerEvent("bluesky.create_post", handleCreatePost);

  runtime.logger.info(
    { src: "bluesky" },
    "Registered Bluesky event handlers (full elizaOS pipeline)",
  );
}

// Export types for tests
export type {
  BlueSkyNotificationEventPayload,
  BlueSkyCreatePostEventPayload,
  BlueSkyNotification,
};
