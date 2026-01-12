// Import from relative paths to avoid self-referential package imports during builds

import { v4 } from "uuid";
import { createUniqueUuid } from "../entities.ts";
import { logger } from "../logger.ts";
import {
  imageDescriptionTemplate,
  messageHandlerTemplate,
  postCreationTemplate,
} from "../prompts.ts";
import { EmbeddingGenerationService } from "../services/embedding.ts";
import { FollowUpService } from "../services/followUp.ts";
import { RolodexService } from "../services/rolodex.ts";
import { TaskService } from "../services/task.ts";
import { Role } from "../types/environment.ts";
import { EventType } from "../types/events.ts";
import type {
  ActionEventPayload,
  ActionLogBody,
  BaseLogBody,
  Content,
  ControlMessagePayload,
  EntityPayload,
  EvaluatorEventPayload,
  IAgentRuntime,
  IMessageBusService,
  InvokePayload,
  Media,
  Memory,
  MentionContext,
  MessageMetadata,
  MessagePayload,
  Plugin,
  PluginEvents,
  Room,
  RunEventPayload,
  UUID,
  WorldPayload,
} from "../types/index.ts";
import { MemoryType } from "../types/memory.ts";
import { ModelType } from "../types/model.ts";
import type { ServiceClass } from "../types/plugin.ts";
import { ChannelType, ContentType } from "../types/primitives.ts";
import { getLocalServerUrl } from "../utils/node.ts";
import { composePromptFromState, parseKeyValueXml } from "../utils.ts";
import * as actions from "./actions/index.ts";
import * as autonomy from "./autonomy/index.ts";
import * as evaluators from "./evaluators/index.ts";
import * as providers from "./providers/index.ts";

/** Shape of image description XML response */
interface ImageDescriptionXml {
  description?: string;
  title?: string;
  text?: string;
}

/** Shape of message handler XML response */
interface MessageHandlerXml {
  thought?: string;
  actions?: string | string[];
  providers?: string | string[];
  text?: string;
  simple?: boolean;
}

/** Shape of post creation XML response */
interface PostCreationXml {
  post?: string;
  thought?: string;
}

export * from "./actions/index.ts";
export * from "./evaluators/index.ts";
export * from "./providers/index.ts";

/**
 * Represents media data containing a buffer of data and the media type.
 * @typedef {Object} MediaData
 * @property {Buffer} data - The buffer of data.
 * @property {string} mediaType - The type of media.
 */
type MediaData = {
  data: Buffer;
  mediaType: string;
};

/**
 * Escapes special characters in a string to make it JSON-safe.
 */
/* // Removing JSON specific helpers
function escapeForJson(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/```/g, '\\`\\`\\`');
}

function sanitizeJson(rawJson: string): string {
  try {
    // Try parsing directly
    JSON.parse(rawJson);
    return rawJson; // Already valid
  } catch {
    // Continue to sanitization
  }

  // first, replace all newlines with \n
  const sanitized = rawJson
    .replace(/\n/g, '\\n')

    // then, replace all backticks with \\\`
    .replace(/`/g, '\\\`');

  // Regex to find and escape the "text" field
  const fixed = sanitized.replace(/"text"\s*:\s*"([\s\S]*?)"\s*,\s*"simple"/, (_match, group) => {
    const escapedText = escapeForJson(group);
    return `"text": "${escapedText}", "simple"`;
  });

  // Validate that the result is actually parseable
  try {
    JSON.parse(fixed);
    return fixed;
  } catch (e) {
    throw new Error(`Failed to sanitize JSON: ${e.message}`);
  }
}
*/

/**
 * Fetches media data from a list of attachments, supporting both HTTP URLs and local file paths.
 *
 * @param attachments Array of Media objects containing URLs or file paths to fetch media from
 * @returns Promise that resolves with an array of MediaData objects containing the fetched media data and content type
 */
/**
 * Fetches media data from given attachments.
 * @param {Media[]} attachments - Array of Media objects to fetch data from.
 * @returns {Promise<MediaData[]>} - A Promise that resolves with an array of MediaData objects.
 */
export async function fetchMediaData(
  attachments: Media[],
): Promise<MediaData[]> {
  return Promise.all(
    attachments.map(async (attachment: Media) => {
      if (/^(http|https):\/\//.test(attachment.url)) {
        // Handle HTTP URLs
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${attachment.url}`);
        }
        const mediaBuffer = Buffer.from(await response.arrayBuffer());
        const mediaType = attachment.contentType || "image/png";
        return { data: mediaBuffer, mediaType };
      }
      // if (fs.existsSync(attachment.url)) {
      //   // Handle local file paths
      //   const mediaBuffer = await fs.promises.readFile(path.resolve(attachment.url));
      //   const mediaType = attachment.contentType || 'image/png';
      //   return { data: mediaBuffer, mediaType };
      // }
      throw new Error(
        `File not found: ${attachment.url}. Make sure the path is correct.`,
      );
    }),
  );
}

/**
 * Processes attachments by generating descriptions for supported media types.
 * Currently supports image description generation.
 *
 * @param {Media[]} attachments - Array of attachments to process
 * @param {IAgentRuntime} runtime - The agent runtime for accessing AI models
 * @returns {Promise<Media[]>} - Returns a new array of processed attachments with added description, title, and text properties
 */
export async function processAttachments(
  attachments: Media[],
  runtime: IAgentRuntime,
): Promise<Media[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  runtime.logger.debug(
    {
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      count: attachments.length,
    },
    "Processing attachments",
  );

  const processedAttachments: Media[] = [];

  for (const attachment of attachments) {
    // Start with the original attachment
    const processedAttachment: Media = { ...attachment };

    const isRemote = /^(http|https):\/\//.test(attachment.url);
    const url = isRemote ? attachment.url : getLocalServerUrl(attachment.url);
    // Only process images that don't already have descriptions
    if (
      attachment.contentType === ContentType.IMAGE &&
      !attachment.description
    ) {
      runtime.logger.debug(
        {
          src: "plugin:bootstrap",
          agentId: runtime.agentId,
          url: attachment.url,
        },
        "Generating description for image",
      );

      let imageUrl = url;

      if (!isRemote) {
        // Only convert local/internal media to base64
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch image: ${res.statusText}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType =
          res.headers.get("content-type") || "application/octet-stream";
        imageUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
      }

      const response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
        prompt: imageDescriptionTemplate,
        imageUrl,
      });

      if (typeof response === "string") {
        // Parse XML response
        const parsedXml = parseKeyValueXml<ImageDescriptionXml>(response);

        if (parsedXml && (parsedXml.description || parsedXml.text)) {
          processedAttachment.description = parsedXml.description ?? "";
          processedAttachment.title = parsedXml.title ?? "Image";
          processedAttachment.text =
            parsedXml.text ?? parsedXml.description ?? "";

          runtime.logger.debug(
            {
              src: "plugin:bootstrap",
              agentId: runtime.agentId,
              descriptionPreview:
                processedAttachment.description?.substring(0, 100) || undefined,
            },
            "Generated description",
          );
        } else {
          // Fallback: Try simple regex parsing if parseKeyValueXml fails
          const responseStr = response as string;
          const titleMatch = responseStr.match(/<title>([^<]+)<\/title>/);
          const descMatch = responseStr.match(
            /<description>([^<]+)<\/description>/,
          );
          const textMatch = responseStr.match(/<text>([^<]+)<\/text>/);

          if (titleMatch || descMatch || textMatch) {
            processedAttachment.title = titleMatch?.[1] || "Image";
            processedAttachment.description = descMatch?.[1] || "";
            processedAttachment.text = textMatch?.[1] || descMatch?.[1] || "";

            runtime.logger.debug(
              {
                src: "plugin:bootstrap",
                agentId: runtime.agentId,
                descriptionPreview:
                  processedAttachment.description?.substring(0, 100) ||
                  undefined,
              },
              "Used fallback XML parsing",
            );
          } else {
            runtime.logger.warn(
              { src: "plugin:bootstrap", agentId: runtime.agentId },
              "Failed to parse XML response for image description",
            );
          }
        }
      } else if (
        response &&
        typeof response === "object" &&
        "description" in response
      ) {
        // Handle object responses for backwards compatibility
        processedAttachment.description = response.description;
        processedAttachment.title = response.title || "Image";
        processedAttachment.text = response.description;

        runtime.logger.debug(
          {
            src: "plugin:bootstrap",
            agentId: runtime.agentId,
            descriptionPreview:
              processedAttachment.description?.substring(0, 100) || undefined,
          },
          "Generated description",
        );
      } else {
        runtime.logger.warn(
          { src: "plugin:bootstrap", agentId: runtime.agentId },
          "Unexpected response format for image description",
        );
      }
    } else if (
      attachment.contentType === ContentType.DOCUMENT &&
      !attachment.text
    ) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch document: ${res.statusText}`);
      }

      const contentType = res.headers.get("content-type") || "";
      const isPlainText = contentType.startsWith("text/plain");

      if (isPlainText) {
        runtime.logger.debug(
          {
            src: "plugin:bootstrap",
            agentId: runtime.agentId,
            url: attachment.url,
          },
          "Processing plain text document",
        );

        const textContent = await res.text();
        processedAttachment.text = textContent;
        processedAttachment.title = processedAttachment.title || "Text File";

        runtime.logger.debug(
          {
            src: "plugin:bootstrap",
            agentId: runtime.agentId,
            textPreview:
              processedAttachment.text?.substring(0, 100) || undefined,
          },
          "Extracted text content",
        );
      } else {
        runtime.logger.warn(
          { src: "plugin:bootstrap", agentId: runtime.agentId, contentType },
          "Skipping non-plain-text document",
        );
      }
    }

    processedAttachments.push(processedAttachment);
  }

  return processedAttachments;
}

/**
 * Determines whether the agent should respond to a message.
 * Uses simple rules for obvious cases (DM, mentions, specific sources) and defers to LLM for ambiguous cases.
 *
 * @returns Object containing:
 *  - shouldRespond: boolean - whether the agent should respond (only relevant if skipEvaluation is true)
 *  - skipEvaluation: boolean - whether we can skip the LLM evaluation (decision made by simple rules)
 *  - reason: string - explanation for debugging
 */
export function shouldRespond(
  runtime: IAgentRuntime,
  message: Memory,
  room?: Room,
  mentionContext?: MentionContext,
): { shouldRespond: boolean; skipEvaluation: boolean; reason: string } {
  if (!room) {
    return {
      shouldRespond: false,
      skipEvaluation: true,
      reason: "no room context",
    };
  }

  function normalizeEnvList(value: unknown): string[] {
    if (!value || typeof value !== "string") {
      return [];
    }
    const cleaned = value.trim().replace(/^[[]|[\]]$/g, "");
    return cleaned
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  // Channel types that always trigger a response (private channels)
  const alwaysRespondChannels = [
    ChannelType.DM,
    ChannelType.VOICE_DM,
    ChannelType.SELF,
    ChannelType.API,
  ];

  // Sources that always trigger a response
  const alwaysRespondSources = ["client_chat"];

  // Support runtime-configurable overrides via env settings
  const customChannels = normalizeEnvList(
    runtime.getSetting("ALWAYS_RESPOND_CHANNELS"),
  );
  const customSources = normalizeEnvList(
    runtime.getSetting("ALWAYS_RESPOND_SOURCES"),
  );

  const respondChannels = new Set(
    [...alwaysRespondChannels.map((t) => t.toString()), ...customChannels].map(
      (s: string) => s.trim().toLowerCase(),
    ),
  );

  const respondSources = [...alwaysRespondSources, ...customSources].map(
    (s: string) => s.trim().toLowerCase(),
  );

  const roomType = room.type?.toString().toLowerCase() || undefined;
  const messageContentSource = message.content.source;
  const sourceStr = messageContentSource?.toLowerCase() || "";

  // 1. DM/VOICE_DM/API channels: always respond (private channels)
  if (roomType && respondChannels.has(roomType)) {
    return {
      shouldRespond: true,
      skipEvaluation: true,
      reason: `private channel: ${roomType}`,
    };
  }

  // 2. Specific sources (e.g., client_chat): always respond
  if (respondSources.some((pattern) => sourceStr.includes(pattern))) {
    return {
      shouldRespond: true,
      skipEvaluation: true,
      reason: `whitelisted source: ${sourceStr}`,
    };
  }

  // 3. Platform mentions and replies: always respond
  // This is the key feature from mentionContext - platform-detected mentions/replies
  const mentionContextIsMention = mentionContext?.isMention;
  const mentionContextIsReply = mentionContext?.isReply;
  const hasPlatformMention = !!(
    mentionContextIsMention || mentionContextIsReply
  );
  if (hasPlatformMention) {
    const mentionType = mentionContextIsMention ? "mention" : "reply";
    return {
      shouldRespond: true,
      skipEvaluation: true,
      reason: `platform ${mentionType}`,
    };
  }

  // 4. All other cases: let the LLM decide
  // The LLM will handle: text-based name detection, indirect questions, conversation context, etc.
  return {
    shouldRespond: false,
    skipEvaluation: false,
    reason: "needs LLM evaluation",
  };
}

/**
 * Handles the receipt of a reaction message and creates a memory in the designated memory manager.
 *
 * @param {Object} params - The parameters for the function.
 * @param {IAgentRuntime} params.runtime - The agent runtime object.
 * @param {Memory} params.message - The reaction message to be stored in memory.
 * @returns {void}
 */
const reactionReceivedHandler = async ({
  runtime,
  message,
}: {
  runtime: IAgentRuntime;
  message: Memory;
}) => {
  await runtime.createMemory(message, "messages");
};

/**
 * Handles the generation of a post (like a Post) and creates a memory for it.
 *
 * @param {Object} params - The parameters for the function.
 * @param {IAgentRuntime} params.runtime - The agent runtime object.
 * @param {Memory} params.message - The post message to be processed.
 * @param {HandlerCallback} params.callback - The callback function to execute after processing.
 * @returns {Promise<void>}
 */
const postGeneratedHandler = async ({
  runtime,
  callback,
  worldId,
  userId,
  roomId,
  source,
}: InvokePayload) => {
  runtime.logger.info(
    { src: "plugin:bootstrap", agentId: runtime.agentId },
    "Generating new post",
  );
  // Ensure world exists first
  await runtime.ensureWorldExists({
    id: worldId,
    name: `${runtime.character.name}'s Feed`,
    agentId: runtime.agentId,
    messageServerId: userId as UUID,
  });

  // Ensure timeline room exists
  await runtime.ensureRoomExists({
    id: roomId,
    name: `${runtime.character.name}'s Feed`,
    source,
    type: ChannelType.FEED,
    channelId: `${userId}-home`,
    messageServerId: userId as UUID,
    worldId,
  });

  const message: Memory = {
    id: createUniqueUuid(runtime, `post-${Date.now()}`) as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: roomId as UUID,
    content: {} as Content,
    metadata: {
      entityName: runtime.character.name,
      type: MemoryType.MESSAGE,
    } as MessageMetadata & { entityName: string },
  };

  // generate thought of which providers to use using messageHandlerTemplate

  // Compose state with relevant context for post generation
  let state = await runtime.composeState(message, [
    "PROVIDERS",
    "CHARACTER",
    "RECENT_MESSAGES",
    "ENTITIES",
  ]);

  // get xUserName
  const entity = await runtime.getEntityById(runtime.agentId);
  interface XMetadata {
    x?: {
      userName?: string;
    };
    userName?: string;
  }
  const entityMetadata = entity?.metadata;
  const metadata = entityMetadata as XMetadata | undefined;
  const metadataX = metadata?.x;
  if (metadataX?.userName || metadata?.userName) {
    state.values.xUserName =
      metadataX?.userName || metadata?.userName || undefined;
  }

  const prompt = composePromptFromState({
    state,
    template:
      runtime.character.templates?.messageHandlerTemplate ||
      messageHandlerTemplate,
  });

  let responseContent: Content | null = null;

  // Retry if missing required fields
  let retries = 0;
  const maxRetries = 3;
  while (
    retries < maxRetries &&
    (!responseContent?.thought || !responseContent?.actions)
  ) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    // Parse XML
    const parsedXml = parseKeyValueXml<MessageHandlerXml>(response);
    if (parsedXml) {
      // Normalize actions/providers to arrays (XML parser may return string or array)
      const actionsRaw = parsedXml.actions;
      const providersRaw = parsedXml.providers;
      responseContent = {
        thought: parsedXml.thought ?? "",
        actions: Array.isArray(actionsRaw)
          ? actionsRaw
          : actionsRaw
            ? [actionsRaw]
            : ["IGNORE"],
        providers: Array.isArray(providersRaw)
          ? providersRaw
          : providersRaw
            ? [providersRaw]
            : [],
        text: parsedXml.text ?? "",
        simple: parsedXml.simple ?? false,
      };
    } else {
      responseContent = null;
    }

    retries++;
    const responseContentThoughtAfter = responseContent?.thought;
    const responseContentActionsAfter = responseContent?.actions;
    if (!responseContentThoughtAfter || !responseContentActionsAfter) {
      runtime.logger.warn(
        {
          src: "plugin:bootstrap",
          agentId: runtime.agentId,
          response,
          parsedXml,
          responseContent,
        },
        "Missing required fields, retrying",
      );
    }
  }

  // update stats with correct providers
  const responseContentProviders = responseContent?.providers;
  state = await runtime.composeState(message, responseContentProviders);

  // Generate prompt for post content
  const postPrompt = composePromptFromState({
    state,
    template:
      runtime.character.templates?.postCreationTemplate || postCreationTemplate,
  });

  // Use TEXT_LARGE model as we expect structured XML text, not a JSON object
  const xmlResponseText = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: postPrompt,
  });

  // Parse the XML response
  const parsedXmlResponse = parseKeyValueXml<PostCreationXml>(xmlResponseText);

  if (!parsedXmlResponse) {
    runtime.logger.error(
      { src: "plugin:bootstrap", agentId: runtime.agentId, xmlResponseText },
      "Failed to parse XML response for post creation",
    );
    throw new Error("Failed to parse XML response for post creation");
  }

  /**
   * Cleans up a post text by removing quotes and fixing newlines
   */
  function cleanupPostText(text: string): string {
    // Remove quotes
    let cleanedText = text.replace(/^['"](.*)['"]$/, "$1");
    // Fix newlines
    cleanedText = cleanedText.replaceAll(/\\n/g, "\n\n");
    cleanedText = cleanedText.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");

    return cleanedText;
  }

  // Cleanup the post text
  const cleanedText = cleanupPostText(parsedXmlResponse.post ?? "");

  // Prepare media if included
  // const mediaData: MediaData[] = [];
  // if (jsonResponse.imagePrompt) {
  // 	const images = await runtime.useModel(ModelType.IMAGE, {
  // 		prompt: jsonResponse.imagePrompt,
  // 		output: "no-schema",
  // 	});
  // 	try {
  // 		// Convert image prompt to Media format for fetchMediaData
  // 		const imagePromptMedia: any[] = images

  // 		// Fetch media using the utility function
  // 		const fetchedMedia = await fetchMediaData(imagePromptMedia);
  // 		mediaData.push(...fetchedMedia);
  // 	} catch (error) {
  // 		runtime.logger.error("Error fetching media for post:", error);
  // 	}
  // }

  // have we posted it before?
  const stateData = state.data;
  const stateDataProviders = stateData?.providers;
  const RM =
    stateDataProviders &&
    (stateDataProviders.RECENT_MESSAGES as
      | { data?: { recentMessages?: Array<{ content: { text?: string } }> } }
      | undefined);
  const RMData = RM?.data;
  const RMDataRecentMessages = RMData?.recentMessages;
  if (RMDataRecentMessages) {
    for (const m of RMDataRecentMessages) {
      if (cleanedText === m.content.text) {
        runtime.logger.info(
          { src: "plugin:bootstrap", agentId: runtime.agentId, cleanedText },
          "Already recently posted that, retrying",
        );
        postGeneratedHandler({
          runtime,
          callback,
          worldId,
          userId,
          roomId,
          source,
        });
        return; // don't call callbacks
      }
    }
  }

  // GPT 3.5/4: /(i\s+do\s+not|i'?m\s+not)\s+(feel\s+)?comfortable\s+generating\s+that\s+type\s+of\s+content|(inappropriate|explicit|offensive|communicate\s+respectfully|aim\s+to\s+(be\s+)?helpful)/i
  const oaiRefusalRegex =
    /((i\s+do\s+not|i'm\s+not)\s+(feel\s+)?comfortable\s+generating\s+that\s+type\s+of\s+content)|(inappropriate|explicit|respectful|offensive|guidelines|aim\s+to\s+(be\s+)?helpful|communicate\s+respectfully)/i;
  const anthropicRefusalRegex =
    /(i'?m\s+unable\s+to\s+help\s+with\s+that\s+request|due\s+to\s+safety\s+concerns|that\s+may\s+violate\s+(our\s+)?guidelines|provide\s+helpful\s+and\s+safe\s+responses|let'?s\s+try\s+a\s+different\s+direction|goes\s+against\s+(our\s+)?use\s+case\s+policies|ensure\s+safe\s+and\s+responsible\s+use)/i;
  const googleRefusalRegex =
    /(i\s+can'?t\s+help\s+with\s+that|that\s+goes\s+against\s+(our\s+)?(policy|policies)|i'?m\s+still\s+learning|response\s+must\s+follow\s+(usage|safety)\s+policies|i'?ve\s+been\s+designed\s+to\s+avoid\s+that)/i;
  //const cohereRefusalRegex = /(request\s+cannot\s+be\s+processed|violates\s+(our\s+)?content\s+policy|not\s+permitted\s+by\s+usage\s+restrictions)/i
  const generalRefusalRegex =
    /(response\s+was\s+withheld|content\s+was\s+filtered|this\s+request\s+cannot\s+be\s+completed|violates\s+our\s+safety\s+policy|content\s+is\s+not\s+available)/i;

  if (
    oaiRefusalRegex.test(cleanedText) ||
    anthropicRefusalRegex.test(cleanedText) ||
    googleRefusalRegex.test(cleanedText) ||
    generalRefusalRegex.test(cleanedText)
  ) {
    runtime.logger.info(
      { src: "plugin:bootstrap", agentId: runtime.agentId, cleanedText },
      "Got prompt moderation refusal, retrying",
    );
    postGeneratedHandler({
      runtime,
      callback,
      worldId,
      userId,
      roomId,
      source,
    });
    return; // don't call callbacks
  }

  // Create the response memory
  const responseMessages = [
    {
      id: v4() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      content: {
        text: cleanedText,
        source,
        channelType: ChannelType.FEED,
        thought: parsedXmlResponse.thought ?? "",
        type: "post",
      },
      roomId: message.roomId,
      createdAt: Date.now(),
    },
  ];

  for (const message of responseMessages) {
    if (callback) {
      await callback(message.content);
    }
  }

  // Process the actions and execute the callback
  // await runtime.processActions(message, responseMessages, state, callback);

  // // Run any configured evaluators
  // await runtime.evaluate(
  // 	message,
  // 	state,
  // 	true, // Post generation is always a "responding" scenario
  // 	callback,
  // 	responseMessages,
  // );
};

/**
 * Syncs a single user into an entity
 */
/**
 * Asynchronously sync a single user with the specified parameters.
 *
 * @param {UUID} entityId - The unique identifier for the entity.
 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
 * @param {UUID} messageServerId - The unique identifier for the message server.
 * @param {string} channelId - The unique identifier for the channel.
 * @param {ChannelType} type - The type of channel.
 * @param {string} source - The source of the user data.
 * @returns {Promise<void>} A promise that resolves once the user is synced.
 */
const syncSingleUser = async (
  entityId: UUID,
  runtime: IAgentRuntime,
  messageServerId: UUID,
  channelId: string,
  type: ChannelType,
  source: string,
) => {
  const entity = await runtime.getEntityById(entityId);
  runtime.logger.info(
    {
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      entityId,
      username: entity?.metadata?.username || undefined,
    },
    "Syncing user",
  );

  // Ensure we're not using WORLD type and that we have a valid channelId
  if (!channelId) {
    runtime.logger.warn(
      {
        src: "plugin:bootstrap",
        agentId: runtime.agentId,
        entityId: entity?.id || undefined,
      },
      "Cannot sync user without a valid channelId",
    );
    return;
  }

  const roomId = createUniqueUuid(runtime, channelId);
  const worldId = createUniqueUuid(runtime, messageServerId);

  // Create world with ownership metadata for DM connections (onboarding)
  const worldMetadata =
    type === ChannelType.DM
      ? {
          ownership: {
            ownerId: entityId,
          },
          roles: {
            [entityId]: Role.OWNER,
          },
          settings: {}, // Initialize empty settings for onboarding
        }
      : undefined;

  runtime.logger.info(
    {
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      type,
      isDM: type === ChannelType.DM,
      worldMetadata,
    },
    "syncSingleUser",
  );

  await runtime.ensureConnection({
    entityId,
    roomId,
    name: (entity?.metadata?.name ||
      entity?.metadata?.username ||
      `User${entityId}`) as undefined | string,
    source,
    channelId,
    messageServerId,
    type,
    worldId,
    metadata: worldMetadata,
  });

  // Verify the world was created with proper metadata
  const createdWorld = await runtime.getWorld(worldId);
  runtime.logger.info(
    {
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      worldId,
      metadata: createdWorld?.metadata || undefined,
    },
    "Created world check",
  );

  runtime.logger.success(
    {
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      agentName: runtime.character.name,
      entityId: entity?.id || undefined,
    },
    "Successfully synced user",
  );
};

/**
 * Handles standardized server data for both WORLD_JOINED and WORLD_CONNECTED events
 */
const handleServerSync = async ({
  runtime,
  world,
  rooms,
  entities,
  source,
  onComplete,
}: WorldPayload) => {
  runtime.logger.debug(
    {
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      serverName: world.name,
    },
    "Handling server sync event",
  );
  await runtime.ensureConnections(entities, rooms, source, world);
  runtime.logger.debug(
    {
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      worldName: world.name,
    },
    "Successfully synced standardized world structure",
  );
  if (onComplete) {
    onComplete();
  }
};

/**
 * Handles control messages for enabling or disabling UI elements in the frontend
 * @param {Object} params - Parameters for the handler
 * @param {IAgentRuntime} params.runtime - The runtime instance
 * @param {Object} params.message - The control message
 * @param {string} params.source - Source of the message
 */
const controlMessageHandler = async ({
  runtime,
  message,
}: ControlMessagePayload) => {
  runtime.logger.debug(
    {
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      action: message.payload.action,
      roomId: message.roomId,
    },
    "Processing control message",
  );

  // Here we would use a WebSocket service to send the control message to the frontend
  // This would typically be handled by a registered service with sendMessage capability

  // Get any registered WebSocket service
  const serviceNames = Array.from(runtime.getAllServices().keys()) as string[];
  const websocketServiceName = serviceNames.find(
    (name: string) =>
      name.toLowerCase().includes("websocket") ||
      name.toLowerCase().includes("socket"),
  );

  if (websocketServiceName) {
    const websocketService = runtime.getService(websocketServiceName);
    interface WebSocketServiceWithSendMessage {
      sendMessage: (message: {
        type: string;
        payload: unknown;
      }) => Promise<void>;
    }
    if (websocketService && "sendMessage" in websocketService) {
      // Send the control message through the WebSocket service
      await (websocketService as WebSocketServiceWithSendMessage).sendMessage({
        type: "controlMessage",
        payload: {
          action: message.payload.action,
          target: message.payload.target,
          roomId: message.roomId,
        },
      });

      runtime.logger.debug(
        {
          src: "plugin:bootstrap",
          agentId: runtime.agentId,
          action: message.payload.action,
        },
        "Control message sent successfully",
      );
    } else {
      runtime.logger.error(
        { src: "plugin:bootstrap", agentId: runtime.agentId },
        "WebSocket service does not have sendMessage method",
      );
    }
  } else {
    runtime.logger.error(
      { src: "plugin:bootstrap", agentId: runtime.agentId },
      "No WebSocket service found to send control message",
    );
  }
};

const events: PluginEvents = {
  [EventType.REACTION_RECEIVED]: [
    async (payload: MessagePayload) => {
      await reactionReceivedHandler(payload);
    },
  ],

  [EventType.POST_GENERATED]: [
    async (payload: InvokePayload) => {
      await postGeneratedHandler(payload);
    },
  ],

  [EventType.MESSAGE_SENT]: [
    async (payload: MessagePayload) => {
      payload.runtime.logger.debug(
        {
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          text: payload.message.content.text,
        },
        "Message sent",
      );
    },
  ],

  [EventType.WORLD_JOINED]: [
    async (payload: WorldPayload) => {
      await handleServerSync(payload);
    },
  ],

  [EventType.WORLD_CONNECTED]: [
    async (payload: WorldPayload) => {
      await handleServerSync(payload);
    },
  ],

  [EventType.ENTITY_JOINED]: [
    async (payload: EntityPayload) => {
      payload.runtime.logger.debug(
        {
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          entityId: payload.entityId,
        },
        "ENTITY_JOINED event received",
      );

      if (!payload.worldId) {
        payload.runtime.logger.error(
          { src: "plugin:bootstrap", agentId: payload.runtime.agentId },
          "No worldId provided for entity joined",
        );
        return;
      }
      if (!payload.roomId) {
        payload.runtime.logger.error(
          { src: "plugin:bootstrap", agentId: payload.runtime.agentId },
          "No roomId provided for entity joined",
        );
        return;
      }
      const payloadMetadata = payload.metadata;
      if (!payloadMetadata || !payloadMetadata.type) {
        payload.runtime.logger.error(
          { src: "plugin:bootstrap", agentId: payload.runtime.agentId },
          "No type provided for entity joined",
        );
        return;
      }

      const channelType = payloadMetadata?.type;
      if (typeof channelType !== "string") {
        payload.runtime.logger.warn("Missing channel type in entity payload");
        return;
      }
      await syncSingleUser(
        payload.entityId,
        payload.runtime,
        payload.worldId,
        payload.roomId,
        channelType as ChannelType,
        payload.source,
      );
    },
  ],

  [EventType.ENTITY_LEFT]: [
    async (payload: EntityPayload) => {
      // Update entity to inactive
      const entity = await payload.runtime.getEntityById(payload.entityId);
      if (entity) {
        entity.metadata = {
          ...entity.metadata,
          status: "INACTIVE",
          leftAt: Date.now(),
        };
        await payload.runtime.updateEntity(entity);
      }
      payload.runtime.logger.info(
        {
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          entityId: payload.entityId,
          worldId: payload.worldId,
        },
        "User left world",
      );
    },
  ],

  [EventType.ACTION_STARTED]: [
    async (payload: ActionEventPayload) => {
      // Only notify for client_chat messages
      const payloadContent = payload.content;
      if (payloadContent && payloadContent.source === "client_chat") {
        const messageBusService =
          payload.runtime.getService<IMessageBusService>("message-bus-service");
        if (messageBusService?.notifyActionStart) {
          await messageBusService.notifyActionStart(
            payload.roomId,
            payload.world,
            payload.content,
            payload.messageId,
          );
        }
      }
    },
    async (payload: ActionEventPayload) => {
      const content = payload.content;
      const contentActions = content?.actions;
      const actionName = contentActions?.[0] ?? "unknown";

      await payload.runtime.log({
        entityId: payload.runtime.agentId,
        roomId: payload.roomId,
        type: "action_event",
        body: {
          runId: (content?.runId as string | undefined) ?? "",
          actionId: (content?.actionId as string | undefined) ?? "",
          actionName: actionName,
          roomId: payload.roomId,
          messageId: payload.messageId,
          timestamp: Date.now(),
          planStep: (content?.planStep as string | undefined) ?? "",
          source: "actionHandler",
        } as ActionLogBody,
      });
      logger.debug(
        {
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          actionName: actionName,
        },
        "Logged ACTION_STARTED event",
      );
    },
  ],

  [EventType.ACTION_COMPLETED]: [
    async (payload: ActionEventPayload) => {
      // Only notify for client_chat messages
      const payloadContent = payload.content;
      if (payloadContent && payloadContent.source === "client_chat") {
        const messageBusService =
          payload.runtime.getService<IMessageBusService>("message-bus-service");
        if (messageBusService?.notifyActionUpdate) {
          await messageBusService.notifyActionUpdate(
            payload.roomId,
            payload.world,
            payload.content,
            payload.messageId,
          );
        }
      }
    },
  ],

  [EventType.EVALUATOR_STARTED]: [
    async (payload: EvaluatorEventPayload) => {
      logger.debug(
        {
          src: "plugin:bootstrap:evaluator",
          agentId: payload.runtime.agentId,
          evaluatorName: payload.evaluatorName,
          evaluatorId: payload.evaluatorId,
        },
        "Evaluator started",
      );
    },
  ],

  [EventType.EVALUATOR_COMPLETED]: [
    async (payload: EvaluatorEventPayload) => {
      const status = payload.error ? "failed" : "completed";
      logger.debug(
        {
          src: "plugin:bootstrap:evaluator",
          agentId: payload.runtime.agentId,
          status,
          evaluatorName: payload.evaluatorName,
          evaluatorId: payload.evaluatorId,
          error: payload.error?.message || undefined,
        },
        "Evaluator completed",
      );
    },
  ],

  [EventType.RUN_STARTED]: [
    async (payload: RunEventPayload) => {
      await payload.runtime.log({
        entityId: payload.entityId,
        roomId: payload.roomId,
        type: "run_event",
        body: {
          runId: payload.runId,
          status: payload.status,
          messageId: payload.messageId,
          roomId: payload.roomId,
          entityId: payload.entityId,
          startTime: payload.startTime,
          source: payload.source || "unknown",
        } as BaseLogBody,
      });
      logger.debug(
        {
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          runId: payload.runId,
        },
        "Logged RUN_STARTED event",
      );
    },
  ],

  [EventType.RUN_ENDED]: [
    async (payload: RunEventPayload) => {
      await payload.runtime.log({
        entityId: payload.entityId,
        roomId: payload.roomId,
        type: "run_event",
        body: {
          runId: payload.runId,
          status: payload.status,
          messageId: payload.messageId,
          roomId: payload.roomId,
          entityId: payload.entityId,
          startTime: payload.startTime,
          endTime: payload.endTime,
          duration: payload.duration,
          error: payload.error,
          source: payload.source || "unknown",
        } as BaseLogBody,
      });
      logger.debug(
        {
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          runId: payload.runId,
          status: payload.status,
        },
        "Logged RUN_ENDED event",
      );
    },
  ],

  [EventType.RUN_TIMEOUT]: [
    async (payload: RunEventPayload) => {
      await payload.runtime.log({
        entityId: payload.entityId,
        roomId: payload.roomId,
        type: "run_event",
        body: {
          runId: payload.runId,
          status: payload.status,
          messageId: payload.messageId,
          roomId: payload.roomId,
          entityId: payload.entityId,
          startTime: payload.startTime,
          endTime: payload.endTime,
          duration: payload.duration,
          error: payload.error,
          source: payload.source || "unknown",
        } as BaseLogBody,
      });
      logger.debug(
        {
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          runId: payload.runId,
        },
        "Logged RUN_TIMEOUT event",
      );
    },
  ],

  [EventType.CONTROL_MESSAGE]: [
    async (payload: ControlMessagePayload) => {
      if (!payload.message) {
        payload.runtime.logger.warn(
          { src: "plugin:bootstrap" },
          "CONTROL_MESSAGE received without message property",
        );
        return;
      }
      await controlMessageHandler(payload);
    },
  ],
};

// ============================================================================
// Capability Configuration
// ============================================================================

/**
 * Configuration for bootstrap capabilities.
 * - Basic: Core functionality (reply, ignore, none actions; core providers; task/embedding services)
 * - Extended: Additional features (choice, mute/follow room, roles, settings, image generation)
 * - Autonomy: Autonomous operation (autonomy service, admin communication, status providers)
 */
export interface CapabilityConfig {
  /** Disable basic capabilities (default: false) */
  disableBasic?: boolean;
  /** Enable extended capabilities (default: false) */
  enableExtended?: boolean;
  /** Skip the character provider (used for anonymous agents without a character file) */
  skipCharacterProvider?: boolean;
  /** Enable autonomy capabilities (default: false) */
  enableAutonomy?: boolean;
}

// Basic capabilities - included by default
const basic = {
  providers: [
    providers.actionsProvider,
    providers.actionStateProvider,
    providers.attachmentsProvider,
    providers.capabilitiesProvider,
    providers.characterProvider,
    providers.entitiesProvider,
    providers.evaluatorsProvider,
    providers.providersProvider,
    providers.recentMessagesProvider,
    providers.timeProvider,
    providers.worldProvider,
  ],
  actions: [actions.replyAction, actions.ignoreAction, actions.noneAction],
  evaluators: [],
  services: [TaskService, EmbeddingGenerationService] as ServiceClass[],
};

// Extended capabilities - opt-in
// Includes rolodex/contact management, relationship tracking, and follow-up scheduling
const extended = {
  providers: [
    providers.choiceProvider,
    providers.contactsProvider,
    providers.factsProvider,
    providers.followUpsProvider,
    providers.knowledgeProvider,
    providers.relationshipsProvider,
    providers.roleProvider,
    providers.settingsProvider,
  ],
  actions: [
    actions.addContactAction,
    actions.choiceAction,
    actions.followRoomAction,
    actions.generateImageAction,
    actions.muteRoomAction,
    actions.removeContactAction,
    actions.scheduleFollowUpAction,
    actions.searchContactsAction,
    actions.sendMessageAction,
    actions.unfollowRoomAction,
    actions.unmuteRoomAction,
    actions.updateContactAction,
    actions.updateEntityAction,
    actions.updateRoleAction,
    actions.updateSettingsAction,
  ],
  evaluators: [
    evaluators.reflectionEvaluator,
    evaluators.relationshipExtractionEvaluator,
  ],
  services: [RolodexService, FollowUpService] as ServiceClass[],
};

// Autonomy capabilities - opt-in
// Provides autonomous operation with continuous agent thinking loop
const autonomyCapabilities = {
  providers: [autonomy.adminChatProvider, autonomy.autonomyStatusProvider],
  actions: [autonomy.sendToAdminAction],
  evaluators: [],
  services: [autonomy.AutonomyService] as ServiceClass[],
  routes: autonomy.autonomyRoutes,
};

/**
 * Create a bootstrap plugin with the specified capability configuration.
 */
export function createBootstrapPlugin(config: CapabilityConfig = {}): Plugin {
  // Filter out character provider if skipCharacterProvider is set
  const basicProviders = config.skipCharacterProvider
    ? basic.providers.filter((p) => p.name !== "CHARACTER")
    : basic.providers;

  return {
    name: "bootstrap",
    description: "Agent bootstrap with basic actions and evaluators",
    actions: [
      ...(config.disableBasic ? [] : basic.actions),
      ...(config.enableExtended ? extended.actions : []),
      ...(config.enableAutonomy ? autonomyCapabilities.actions : []),
    ],
    providers: [
      ...(config.disableBasic ? [] : basicProviders),
      ...(config.enableExtended ? extended.providers : []),
      ...(config.enableAutonomy ? autonomyCapabilities.providers : []),
    ],
    evaluators: [
      ...(config.disableBasic ? [] : basic.evaluators),
      ...(config.enableExtended ? extended.evaluators : []),
      ...(config.enableAutonomy ? autonomyCapabilities.evaluators : []),
    ],
    services: [
      ...(config.disableBasic ? [] : basic.services),
      ...(config.enableExtended ? extended.services : []),
      ...(config.enableAutonomy ? autonomyCapabilities.services : []),
    ],
    routes: [...(config.enableAutonomy ? autonomyCapabilities.routes : [])],
    events,
  };
}

// Bootstrap plugin is now built into core and auto-registered during runtime initialization.
// External code should NOT import or use bootstrapPlugin directly.
// The createBootstrapPlugin function is used internally by the runtime.

// Export capability arrays for direct access if needed
export {
  basic as basicCapabilities,
  extended as extendedCapabilities,
  autonomyCapabilities,
};

// Export autonomy components for direct access
export * from "./autonomy/index.ts";
