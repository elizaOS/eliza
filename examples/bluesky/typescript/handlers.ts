import {
  composePrompt,
  type IAgentRuntime,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";

const BLUESKY_SERVICE_NAME = "bluesky";

// BlueSky types - inlined to avoid build order issues
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
  getMessageService(agentId: UUID): unknown;
}

/**
 * Create a unique UUID by combining base ID with agent ID
 */
function createUniqueUuid(runtime: IAgentRuntime, baseId: string): UUID {
  const combinedString = `${baseId}:${runtime.agentId}`;
  return stringToUuid(combinedString);
}

/**
 * Template for generating replies to mentions
 */
const replyTemplate = `# Task: Generate a reply to a Bluesky mention

You are {{agentName}}, responding to a mention on Bluesky.

## Your Character
{{bio}}

## The Mention
From: @{{authorHandle}}
Text: {{mentionText}}

## Guidelines
- Keep your response under 280 characters (leave room for @mention)
- Be helpful, friendly, and on-brand
- Address the user's question or comment directly
- Don't use hashtags unless relevant

Generate a concise, engaging reply:`;

/**
 * Template for generating automated posts
 */
const postTemplate = `# Task: Generate an original Bluesky post

You are {{agentName}}, creating an original post on Bluesky.

## Your Character
{{bio}}

## Post Examples
{{postExamples}}

## Guidelines
- Keep it under 300 characters
- Be engaging and on-brand
- Share something interesting, helpful, or thought-provoking
- Don't use excessive hashtags or emojis

Generate an original post:`;

/**
 * Get the BlueSky service from the runtime
 */
function getBlueSkyService(runtime: IAgentRuntime): BlueSkyServiceType | null {
  const service = runtime.getService(BLUESKY_SERVICE_NAME);
  return service as BlueSkyServiceType | null;
}

/**
 * Handler for bluesky.mention_received events
 * Processes incoming mentions and generates replies
 */
export async function handleMentionReceived(
  payload: BlueSkyNotificationEventPayload,
): Promise<void> {
  const { runtime, notification } = payload;

  runtime.logger.info(
    { handle: notification.author.handle, reason: notification.reason },
    "Processing Bluesky mention",
  );

  // Skip if not a mention or reply
  if (notification.reason !== "mention" && notification.reason !== "reply") {
    return;
  }

  // Extract the post text from the notification record
  const record = notification.record as { text?: string };
  const mentionText = record.text || "";

  if (!mentionText.trim()) {
    runtime.logger.debug("Empty mention text, skipping");
    return;
  }

  // Create room and entity IDs for this conversation
  const entityId = createUniqueUuid(runtime, notification.author.did);
  const roomId = createUniqueUuid(runtime, notification.uri);

  // Ensure connection exists
  await runtime.ensureConnection({
    entityId,
    roomId,
    userName: notification.author.handle,
    name: notification.author.displayName || notification.author.handle,
    source: "bluesky",
    channelId: notification.uri,
    type: "GROUP",
    worldId: stringToUuid("bluesky-world"),
  });

  // Create memory for the incoming mention
  const messageMemory: Memory = {
    id: stringToUuid(uuidv4()),
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: mentionText,
      source: "bluesky",
      metadata: {
        uri: notification.uri,
        cid: notification.cid,
        authorDid: notification.author.did,
        authorHandle: notification.author.handle,
      },
    },
    createdAt: Date.now(),
  };

  await runtime.createMemory(messageMemory, "messages");

  // Generate reply using the LLM
  const bioText = Array.isArray(runtime.character.bio)
    ? runtime.character.bio.join(" ")
    : runtime.character.bio || "";

  const promptResult = composePrompt({
    state: {
      agentName: runtime.character.name,
      bio: bioText,
      authorHandle: notification.author.handle,
      mentionText,
    },
    template: replyTemplate,
  });
  const prompt: string = Array.isArray(promptResult)
    ? promptResult.join("\n")
    : promptResult;

  const response = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    maxTokens: 100,
    temperature: 0.7,
  });

  const replyText = (response as string).trim();

  if (!replyText) {
    runtime.logger.warn("Generated empty reply, skipping");
    return;
  }

  // Get the service and post the reply
  const service = getBlueSkyService(runtime);
  if (!service) {
    runtime.logger.error("Cannot post reply: BlueSky service not available");
    return;
  }

  const postService = service.getPostService(runtime.agentId);
  if (!postService) {
    runtime.logger.error("Cannot post reply: post service not available");
    return;
  }

  try {
    // Post the reply
    const post = await postService.createPost(replyText, {
      uri: notification.uri,
      cid: notification.cid,
    });

    runtime.logger.info(
      { uri: post.uri, replyTo: notification.author.handle },
      "Posted reply to mention",
    );

    // Store the reply in memory
    const replyMemory: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: {
        text: replyText,
        source: "bluesky",
        inReplyTo: messageMemory.id,
        metadata: {
          uri: post.uri,
          cid: post.cid,
        },
      },
      createdAt: Date.now(),
    };

    await runtime.createMemory(replyMemory, "messages");
  } catch (error) {
    runtime.logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to post reply",
    );
  }
}

/**
 * Handler for bluesky.create_post events
 * Generates and posts automated content
 */
export async function handleCreatePost(
  payload: BlueSkyCreatePostEventPayload,
): Promise<void> {
  const { runtime, automated } = payload;

  if (!automated) {
    return;
  }

  runtime.logger.info("Generating automated Bluesky post");

  // Get post examples from character
  const postExamples = runtime.character.postExamples?.join("\n- ") || "";
  const bioText2 = Array.isArray(runtime.character.bio)
    ? runtime.character.bio.join(" ")
    : runtime.character.bio || "";

  // Generate post content
  const promptResult2 = composePrompt({
    state: {
      agentName: runtime.character.name,
      bio: bioText2,
      postExamples: postExamples ? `- ${postExamples}` : "No examples provided",
    },
    template: postTemplate,
  });
  const prompt: string = Array.isArray(promptResult2)
    ? promptResult2.join("\n")
    : promptResult2;

  const response = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    maxTokens: 100,
    temperature: 0.8,
  });

  const postText = (response as string).trim();

  if (!postText) {
    runtime.logger.warn("Generated empty post, skipping");
    return;
  }

  // Get the service and create the post
  const service = getBlueSkyService(runtime);
  if (!service) {
    runtime.logger.error("Cannot create post: BlueSky service not available");
    return;
  }

  const postService = service.getPostService(runtime.agentId);
  if (!postService) {
    runtime.logger.error("Cannot create post: post service not available");
    return;
  }

  try {
    const post = await postService.createPost(postText);
    runtime.logger.info({ uri: post.uri }, "Created automated post");

    // Store in memory
    const roomId = stringToUuid("bluesky-automated-posts");
    const postMemory: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: {
        text: postText,
        source: "bluesky",
        metadata: {
          uri: post.uri,
          cid: post.cid,
          automated: true,
        },
      },
      createdAt: Date.now(),
    };

    await runtime.createMemory(postMemory, "messages");
  } catch (error) {
    runtime.logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to create automated post",
    );
  }
}

/**
 * Handler for bluesky.should_respond events
 * Decides whether the agent should respond to a notification
 */
export async function handleShouldRespond(
  payload: BlueSkyNotificationEventPayload,
): Promise<void> {
  const { notification } = payload;

  // For now, respond to all mentions and replies
  if (notification.reason === "mention" || notification.reason === "reply") {
    await handleMentionReceived(payload);
  }
}

/**
 * Register all Bluesky event handlers with the runtime
 */
export function registerBlueskyHandlers(runtime: IAgentRuntime): void {
  runtime.registerEvent("bluesky.mention_received", handleMentionReceived);
  runtime.registerEvent("bluesky.should_respond", handleShouldRespond);
  runtime.registerEvent("bluesky.create_post", handleCreatePost);

  runtime.logger.info("Registered Bluesky event handlers");
}
