/**
 * A2A Skills Implementation
 *
 * Core skill implementations for A2A protocol.
 * Only includes skills that are fully tested and working.
 *
 * Note: CoT budget uses env-only resolution (no per-character settings) because
 * A2A skills operate at the protocol level without a resolved character context.
 * The calling agent's character is not available here — skills are invoked via
 * the A2A protocol which only provides user/org context, not agent personality.
 */

import { streamText } from "ai";
import { calculateCost, estimateRequestCost, getProviderFromModel } from "@/lib/pricing";
import {
  mergeAnthropicCotProviderOptions,
  mergeGoogleImageModalitiesWithAnthropicCot,
  resolveAnthropicThinkingBudgetTokens,
} from "@/lib/providers/anthropic-thinking";
import { getLanguageModel } from "@/lib/providers/language-model";
import { agentService } from "@/lib/services/agents/agents";
import { calculateImageGenerationCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  createHostedBrowserSession,
  deleteHostedBrowserSession,
  executeHostedBrowserCommand,
  extractHostedPage,
  getHostedBrowserSession,
  getHostedBrowserSnapshot,
  listHostedBrowserSessions,
  navigateHostedBrowserSession,
} from "@/lib/services/browser-tools";
import { charactersService } from "@/lib/services/characters/characters";
import { containersService } from "@/lib/services/containers";
import { conversationsService } from "@/lib/services/conversations";
import {
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { executeHostedGoogleSearch } from "@/lib/services/google-search";
import { memoryService } from "@/lib/services/memory";
import { organizationsService } from "@/lib/services/organizations";
import { usageService } from "@/lib/services/usage";
import type {
  A2AContext,
  BalanceResult,
  BrowserSessionResult,
  ChatCompletionResult,
  ChatWithAgentResult,
  CreateConversationResult,
  ExtractPageResult,
  ImageGenerationResult,
  ListAgentsResult,
  ListContainersResult,
  RetrieveMemoriesResult,
  SaveMemoryResult,
  UsageResult,
  VideoGenerationResult,
  WebSearchResult,
} from "./types";

const MIN_RESPONSE_TOKENS = 4096;

/**
 * Chat completion skill - Generate text with LLMs
 */
export async function executeSkillChatCompletion(
  textContent: string,
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<ChatCompletionResult> {
  const model = (dataContent.model as string) || "gpt-4o";
  const messages = (dataContent.messages as Array<{
    role: string;
    content: string;
  }>) || [{ role: "user", content: textContent }];
  const options = {
    temperature: dataContent.temperature as number | undefined,
    maxTokens: dataContent.max_tokens as number | undefined,
  };

  const cotBudget = resolveAnthropicThinkingBudgetTokens(model, process.env);
  const effectiveMaxTokens =
    cotBudget != null
      ? Math.max(options.maxTokens ?? MIN_RESPONSE_TOKENS, cotBudget + MIN_RESPONSE_TOKENS)
      : options.maxTokens;
  const provider = getProviderFromModel(model);
  const estimatedCost = await estimateRequestCost(model, messages, effectiveMaxTokens);

  // Reserve credits BEFORE the operation (TOCTOU-safe)
  let reservation: CreditReservation;
  try {
    reservation = await creditsService.reserve({
      organizationId: ctx.user.organization_id,
      amount: estimatedCost,
      userId: ctx.user.id,
      description: `A2A chat: ${model}`,
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      throw new Error(
        `Insufficient credits: need $${error.required.toFixed(4)}, have $${error.available.toFixed(4)}`,
      );
    }
    throw error;
  }

  try {
    const result = await streamText({
      model: getLanguageModel(model),
      messages: messages.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      })),
      ...options,
      ...(effectiveMaxTokens != null && {
        maxOutputTokens: effectiveMaxTokens,
      }),
      ...(cotBudget != null ? mergeAnthropicCotProviderOptions(model, process.env, cotBudget) : {}),
    });

    let fullText = "";
    for await (const delta of result.textStream) fullText += delta;
    const usage = await result.usage;

    const { inputCost, outputCost, totalCost } = await calculateCost(
      model,
      provider,
      usage?.inputTokens || 0,
      usage?.outputTokens || 0,
    );

    // Reconcile with actual cost
    await reservation.reconcile(totalCost);

    await usageService.create({
      organization_id: ctx.user.organization_id,
      user_id: ctx.user.id,
      api_key_id: ctx.apiKeyId,
      type: "chat",
      model,
      provider,
      input_tokens: usage?.inputTokens || 0,
      output_tokens: usage?.outputTokens || 0,
      input_cost: String(inputCost),
      output_cost: String(outputCost),
      is_successful: true,
    });

    return {
      content: fullText,
      model,
      usage: {
        inputTokens: usage?.inputTokens || 0,
        outputTokens: usage?.outputTokens || 0,
        totalTokens: usage?.totalTokens || 0,
      },
      cost: totalCost,
    };
  } catch (error) {
    // Refund on failure
    await reservation.reconcile(0);
    throw error;
  }
}

/**
 * Hosted web search skill
 */
export async function executeSkillWebSearch(
  textContent: string,
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<WebSearchResult> {
  const query = ((dataContent.query as string | undefined) || textContent).trim();
  if (!query) {
    throw new Error("Search query required");
  }

  return await executeHostedGoogleSearch(
    {
      query,
      maxResults: (dataContent.maxResults ?? dataContent.max_results) as number | undefined,
      model: dataContent.model as string | undefined,
      source: dataContent.source as string | undefined,
      topic: dataContent.topic as "general" | "finance" | undefined,
      timeRange: (dataContent.timeRange ?? dataContent.time_range) as
        | "day"
        | "week"
        | "month"
        | "year"
        | "d"
        | "w"
        | "m"
        | "y"
        | undefined,
      startDate: (dataContent.startDate ?? dataContent.start_date) as string | undefined,
      endDate: (dataContent.endDate ?? dataContent.end_date) as string | undefined,
    },
    {
      organizationId: ctx.user.organization_id,
      userId: ctx.user.id,
      apiKeyId: ctx.apiKeyId,
      requestSource: "a2a",
    },
  );
}

export async function executeSkillExtractPage(
  textContent: string,
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<ExtractPageResult> {
  const url = ((dataContent.url as string | undefined) || textContent).trim();
  if (!url) {
    throw new Error("Extract URL required");
  }

  return extractHostedPage(
    {
      formats: dataContent.formats as
        | Array<"html" | "links" | "markdown" | "screenshot">
        | undefined,
      onlyMainContent: dataContent.onlyMainContent as boolean | undefined,
      timeoutMs: dataContent.timeoutMs as number | undefined,
      url,
      waitFor: dataContent.waitFor as number | undefined,
    },
    {
      apiKeyId: ctx.apiKeyId,
      organizationId: ctx.user.organization_id,
      requestSource: "a2a",
      userId: ctx.user.id,
    },
  );
}

export async function executeSkillBrowserSession(
  textContent: string,
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<BrowserSessionResult> {
  const operation =
    (dataContent.operation as string | undefined)?.trim().toLowerCase() || "command";
  const sessionId = (dataContent.sessionId as string | undefined)?.trim();

  const auth = {
    apiKeyId: ctx.apiKeyId,
    organizationId: ctx.user.organization_id,
    requestSource: "a2a" as const,
    userId: ctx.user.id,
  };

  switch (operation) {
    case "list":
      return { sessions: await listHostedBrowserSessions(auth) };
    case "create":
      return {
        session: await createHostedBrowserSession(
          {
            activityTtl: dataContent.activityTtl as number | undefined,
            title: dataContent.title as string | undefined,
            ttl: dataContent.ttl as number | undefined,
            url: (dataContent.url as string | undefined) || textContent || undefined,
          },
          auth,
        ),
      };
    case "get":
      if (!sessionId) throw new Error("sessionId required");
      return { session: await getHostedBrowserSession(sessionId, auth) };
    case "delete":
      if (!sessionId) throw new Error("sessionId required");
      return {
        closed: (await deleteHostedBrowserSession(sessionId, auth)).success === true,
      };
    case "navigate":
      if (!sessionId) throw new Error("sessionId required");
      return {
        session: await navigateHostedBrowserSession(
          sessionId,
          ((dataContent.url as string | undefined) || textContent).trim(),
          auth,
        ),
      };
    case "snapshot":
      if (!sessionId) throw new Error("sessionId required");
      return {
        session: await getHostedBrowserSession(sessionId, auth),
        snapshot: await getHostedBrowserSnapshot(sessionId, auth),
      };
    case "command":
      if (!sessionId) throw new Error("sessionId required");
      return await executeHostedBrowserCommand(
        sessionId,
        {
          id: sessionId,
          key: dataContent.key as string | undefined,
          pixels: dataContent.pixels as number | undefined,
          script: dataContent.script as string | undefined,
          selector: dataContent.selector as string | undefined,
          subaction: dataContent.subaction as
            | "back"
            | "click"
            | "eval"
            | "forward"
            | "get"
            | "navigate"
            | "press"
            | "reload"
            | "scroll"
            | "state"
            | "type"
            | "wait",
          text: dataContent.text as string | undefined,
          timeoutMs: dataContent.timeoutMs as number | undefined,
          url: dataContent.url as string | undefined,
        },
        auth,
      );
    default:
      throw new Error(`Unsupported browser operation: ${operation}`);
  }
}

/**
 * Image generation skill
 */
export async function executeSkillImageGeneration(
  textContent: string,
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<ImageGenerationResult> {
  const prompt = (dataContent.prompt as string) || textContent;
  const aspectRatio = (dataContent.aspectRatio as string) || "1:1";

  if (!prompt) throw new Error("Image prompt required");
  const imageCost = await calculateImageGenerationCostFromCatalog({
    model: "google/gemini-2.5-flash-image",
    provider: "google",
    imageCount: 1,
    dimensions: { size: "default" },
  });

  // Reserve credits BEFORE the operation (TOCTOU-safe)
  let reservation: CreditReservation;
  try {
    reservation = await creditsService.reserve({
      organizationId: ctx.user.organization_id,
      amount: imageCost.totalCost,
      userId: ctx.user.id,
      description: "A2A image generation",
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      throw new Error(`Insufficient credits: need $${imageCost.totalCost.toFixed(4)}`);
    }
    throw error;
  }

  try {
    const generation = await generationsService.create({
      organization_id: ctx.user.organization_id,
      user_id: ctx.user.id,
      api_key_id: ctx.apiKeyId,
      type: "image",
      model: "google/gemini-2.5-flash-image",
      provider: "google",
      prompt,
      status: "pending",
      credits: String(imageCost.totalCost),
      cost: String(imageCost.totalCost),
    });

    const aspectDesc: Record<string, string> = {
      "1:1": "square",
      "16:9": "wide landscape",
      "9:16": "tall portrait",
      "4:3": "landscape",
      "3:4": "portrait",
    };

    const imageModelId = "google/gemini-2.5-flash-image";
    const result = streamText({
      model: imageModelId,
      ...mergeGoogleImageModalitiesWithAnthropicCot(imageModelId),
      prompt: `Generate an image: ${prompt}, ${aspectDesc[aspectRatio] || "square"} composition`,
    });

    let imageBase64: string | null = null;
    let mimeType = "image/png";

    for await (const delta of result.fullStream) {
      if (delta.type === "file" && delta.file.mediaType.startsWith("image/")) {
        mimeType = delta.file.mediaType || "image/png";
        imageBase64 = `data:${mimeType};base64,${Buffer.from(delta.file.uint8Array).toString("base64")}`;
        break;
      }
    }

    if (!imageBase64) {
      await reservation.reconcile(0); // Full refund
      throw new Error("No image generated");
    }

    await generationsService.update(generation.id, {
      status: "completed",
      content: imageBase64,
      mime_type: mimeType,
      completed_at: new Date(),
    });

    // Reconcile with actual cost (same as estimated for fixed-price operations)
    await reservation.reconcile(imageCost.totalCost);

    return {
      image: imageBase64,
      mimeType,
      aspectRatio,
      cost: imageCost.totalCost,
    };
  } catch (error) {
    // Refund on failure
    await reservation.reconcile(0);
    throw error;
  }
}

/**
 * Check balance skill
 */
export async function executeSkillCheckBalance(ctx: A2AContext): Promise<BalanceResult> {
  const org = await organizationsService.getById(ctx.user.organization_id);
  if (!org) throw new Error("Organization not found");
  return {
    balance: Number(org.credit_balance),
    organizationId: org.id,
    organizationName: org.name,
  };
}

/**
 * Get usage skill
 */
export async function executeSkillGetUsage(
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<UsageResult> {
  const limit = Math.min(50, (dataContent.limit as number) || 10);
  const records = await usageService.listByOrganization(ctx.user.organization_id, limit);
  return {
    usage: records.map((r) => ({
      id: r.id,
      type: r.type,
      model: r.model ?? "unknown",
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalCost: Number(r.input_cost || 0) + Number(r.output_cost || 0),
      createdAt: r.created_at.toISOString(),
    })),
    total: records.length,
  };
}

/**
 * List agents skill
 */
export async function executeSkillListAgents(
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<ListAgentsResult> {
  const limit = (dataContent.limit as number) || 20;
  const chars = await charactersService.listByOrganization(ctx.user.organization_id);
  return {
    agents: chars.slice(0, limit).map((c) => ({
      id: c.id,
      name: c.name,
      bio: c.bio,
      avatarUrl: c.avatar_url,
      createdAt: c.created_at,
    })),
    total: chars.length,
  };
}

/**
 * Chat with agent skill
 */
export async function executeSkillChatWithAgent(
  textContent: string,
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<ChatWithAgentResult> {
  const message = (dataContent.message as string) || textContent;
  const roomId = dataContent.roomId as string | undefined;
  const agentId = dataContent.agentId as string | undefined;
  const entityId = ctx.user.id;

  if (!message) throw new Error("Message required");
  if (!agentId && !roomId) throw new Error("agentId or roomId required");

  // If we have a roomId, use it directly; otherwise create/get a room for the agent
  const actualRoomId = roomId || (await agentService.getOrCreateRoom(entityId, agentId!));

  const response = await agentService.sendMessage({
    roomId: actualRoomId,
    entityId,
    message,
    organizationId: ctx.user.organization_id,
    streaming: false,
  });

  return {
    response: response.content,
    roomId: actualRoomId,
    messageId: response.messageId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Save memory skill
 */
export async function executeSkillSaveMemory(
  textContent: string,
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<SaveMemoryResult> {
  const content = (dataContent.content as string) || textContent;
  const type = (dataContent.type as "fact" | "preference" | "context" | "document") || "fact";
  const roomId = dataContent.roomId as string;
  const tags = dataContent.tags as string[] | undefined;
  const metadata = dataContent.metadata as Record<string, unknown> | undefined;

  if (!content || !roomId) throw new Error("content and roomId required");

  const COST = 1;

  // Reserve credits BEFORE the operation (TOCTOU-safe)
  let reservation: CreditReservation;
  try {
    reservation = await creditsService.reserve({
      organizationId: ctx.user.organization_id,
      amount: COST,
      userId: ctx.user.id,
      description: `A2A memory: ${type}`,
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      throw new Error("Insufficient credits");
    }
    throw error;
  }

  try {
    const result = await memoryService.saveMemory({
      organizationId: ctx.user.organization_id,
      roomId,
      entityId: ctx.user.id,
      content,
      type,
      tags,
      metadata,
      persistent: true,
    });

    await reservation.reconcile(COST);
    return { memoryId: result.memoryId, storage: result.storage, cost: COST };
  } catch (error) {
    await reservation.reconcile(0);
    throw error;
  }
}

/**
 * Retrieve memories skill
 */
export async function executeSkillRetrieveMemories(
  textContent: string,
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<RetrieveMemoriesResult> {
  const query = (dataContent.query as string) || textContent;
  const roomId = dataContent.roomId as string | undefined;
  const type = dataContent.type as string[] | undefined;
  const tags = dataContent.tags as string[] | undefined;
  const limit = Math.min(50, (dataContent.limit as number) || 10);
  const sortBy = (dataContent.sortBy as "relevance" | "recent" | "importance") || "relevance";

  const memories = await memoryService.retrieveMemories({
    organizationId: ctx.user.organization_id,
    query,
    roomId,
    type,
    tags,
    limit,
    sortBy,
  });

  return {
    memories: memories.map((m) => ({
      id: m.memory.id || "",
      content:
        typeof m.memory.content === "string" ? m.memory.content : JSON.stringify(m.memory.content),
      score: m.score,
      createdAt:
        typeof m.memory.createdAt === "string"
          ? m.memory.createdAt
          : new Date(m.memory.createdAt ?? Date.now()).toISOString(),
    })),
    count: memories.length,
  };
}

/**
 * Create conversation skill
 */
export async function executeSkillCreateConversation(
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<CreateConversationResult> {
  const title = dataContent.title as string;
  const model = (dataContent.model as string) || "gpt-4o";
  const systemPrompt = dataContent.systemPrompt as string | undefined;

  if (!title) throw new Error("title required");

  const COST = 1;

  // Reserve credits BEFORE the operation (TOCTOU-safe)
  let reservation: CreditReservation;
  try {
    reservation = await creditsService.reserve({
      organizationId: ctx.user.organization_id,
      amount: COST,
      userId: ctx.user.id,
      description: `A2A conversation: ${title}`,
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      throw new Error("Insufficient credits");
    }
    throw error;
  }

  try {
    const conv = await conversationsService.create({
      organization_id: ctx.user.organization_id,
      user_id: ctx.user.id,
      title,
      model,
      settings: { systemPrompt },
    });

    await reservation.reconcile(COST);
    return {
      conversationId: conv.id,
      title: conv.title,
      model: conv.model,
      cost: COST,
    };
  } catch (error) {
    await reservation.reconcile(0);
    throw error;
  }
}

/**
 * List containers skill
 */
export async function executeSkillListContainers(
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<ListContainersResult> {
  const status = dataContent.status as string | undefined;
  let containers = await containersService.listByOrganization(ctx.user.organization_id);
  if (status) containers = containers.filter((c) => c.status === status);
  return {
    containers: containers.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      url: c.load_balancer_url,
      createdAt: c.created_at,
    })),
    total: containers.length,
  };
}

/**
 * Delete memory skill
 */
export async function executeSkillDeleteMemory(
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<{ success: boolean; memoryId: string }> {
  const memoryId = dataContent.memoryId as string;
  if (!memoryId) throw new Error("memoryId required");

  await memoryService.deleteMemory({
    organizationId: ctx.user.organization_id,
    memoryId,
  });
  return { success: true, memoryId };
}

/**
 * Get conversation context skill
 */
export async function executeSkillGetConversationContext(
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<{ context: Record<string, unknown> }> {
  const conversationId = dataContent.conversationId as string;
  if (!conversationId) throw new Error("conversationId required");

  const conversation = await conversationsService.getById(conversationId);
  if (!conversation || conversation.organization_id !== ctx.user.organization_id) {
    throw new Error("Conversation not found");
  }

  return {
    context: {
      id: conversation.id,
      title: conversation.title,
      model: conversation.model,
      settings: conversation.settings,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    },
  };
}

/**
 * Video generation skill (async - returns job ID)
 */
export async function executeSkillVideoGeneration(
  textContent: string,
  dataContent: Record<string, unknown>,
  ctx: A2AContext,
): Promise<VideoGenerationResult> {
  const prompt = (dataContent.prompt as string) || textContent;
  const model = (dataContent.model as string) || "fal-ai/veo3";

  if (!prompt) throw new Error("Video prompt required");

  const VIDEO_COST = 5; // $5 per video

  // Reserve credits BEFORE the operation (TOCTOU-safe)
  let reservation: CreditReservation;
  try {
    reservation = await creditsService.reserve({
      organizationId: ctx.user.organization_id,
      amount: VIDEO_COST,
      userId: ctx.user.id,
      description: "A2A video generation",
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      throw new Error(`Insufficient credits: need $${VIDEO_COST.toFixed(2)}`);
    }
    throw error;
  }

  try {
    const generation = await generationsService.create({
      organization_id: ctx.user.organization_id,
      user_id: ctx.user.id,
      api_key_id: ctx.apiKeyId,
      type: "video",
      model,
      provider: "fal",
      prompt,
      status: "pending",
      credits: String(VIDEO_COST),
      cost: String(VIDEO_COST),
    });

    await reservation.reconcile(VIDEO_COST);
    return {
      jobId: generation.id,
      status: "pending",
      cost: VIDEO_COST,
    };
  } catch (error) {
    await reservation.reconcile(0);
    throw error;
  }
}

/**
 * Get user profile skill
 */
export async function executeSkillGetUserProfile(
  ctx: A2AContext,
): Promise<{ user: Record<string, unknown> }> {
  return {
    user: {
      id: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      organizationId: ctx.user.organization_id,
      creditBalance: ctx.user.organization.credit_balance,
    },
  };
}
