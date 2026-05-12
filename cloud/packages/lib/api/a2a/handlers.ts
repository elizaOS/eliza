/**
 * A2A Method Handlers
 *
 * Implements the A2A protocol standard methods and task management.
 */

import { v4 as uuidv4 } from "uuid";
import { a2aTaskStoreService, type TaskStoreEntry } from "@/lib/services/a2a-task-store";
import { contentModerationService } from "@/lib/services/content-moderation";
import { logger } from "@/lib/utils/logger";
import {
  executeSkillBrowserSession,
  executeSkillChatCompletion,
  executeSkillChatWithAgent,
  executeSkillCheckBalance,
  executeSkillCreateConversation,
  executeSkillDeleteMemory,
  executeSkillExtractPage,
  executeSkillGetConversationContext,
  executeSkillGetUsage,
  executeSkillGetUserProfile,
  executeSkillImageGeneration,
  executeSkillListAgents,
  executeSkillListContainers,
  executeSkillRetrieveMemories,
  executeSkillSaveMemory,
  executeSkillVideoGeneration,
  executeSkillWebSearch,
} from "./skills";
import {
  type A2AContext,
  type Artifact,
  createArtifact,
  createDataPart,
  createMessage,
  createTask,
  createTaskStatus,
  createTextPart,
  type Message,
  type MessageSendParams,
  type Task,
  type TaskCancelParams,
  type TaskGetParams,
  type TaskState,
} from "./types";

// Task store helpers
async function getTaskStore(
  taskId: string,
  organizationId: string,
): Promise<TaskStoreEntry | null> {
  return a2aTaskStoreService.get(taskId, organizationId);
}

async function updateTaskState(
  taskId: string,
  organizationId: string,
  state: TaskState,
  message?: Message,
): Promise<Task | null> {
  return a2aTaskStoreService.updateTaskState(taskId, organizationId, state, message);
}

async function addArtifactToTask(
  taskId: string,
  organizationId: string,
  artifact: Artifact,
): Promise<Task | null> {
  return a2aTaskStoreService.addArtifact(taskId, organizationId, artifact);
}

async function addMessageToHistory(
  taskId: string,
  organizationId: string,
  message: Message,
): Promise<void> {
  await a2aTaskStoreService.addMessageToHistory(taskId, organizationId, message);
}

async function storeTask(
  taskId: string,
  task: Task,
  userId: string,
  organizationId: string,
): Promise<void> {
  await a2aTaskStoreService.set(taskId, {
    task,
    userId,
    organizationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * message/send - Core A2A method
 * Sends a message to create a new task or continue an existing one
 */
export async function handleMessageSend(
  params: MessageSendParams,
  ctx: A2AContext,
): Promise<Task | Message> {
  const { message, configuration, metadata } = params;

  if (!message?.parts?.length) {
    throw new Error("Message must contain at least one part");
  }

  // Check if user is blocked due to moderation violations
  if (await contentModerationService.shouldBlockUser(ctx.user.id)) {
    throw new Error("Account suspended due to policy violations");
  }

  // Extract text content for moderation
  const textContent = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  if (textContent) {
    contentModerationService.moderateInBackground(textContent, ctx.user.id, undefined, (result) => {
      logger.warn("[A2A] Moderation violation detected", {
        userId: ctx.user.id,
        categories: result.flaggedCategories,
        action: result.action,
      });
    });
  }

  // Create a new task
  const taskId = (metadata?.taskId as string | undefined) || uuidv4();
  const contextId = (metadata?.contextId as string | undefined) || uuidv4();

  const task = createTask(taskId, "working", undefined, contextId, metadata);

  // Store the task
  await storeTask(taskId, task, ctx.user.id, ctx.user.organization_id);

  // Add user message to history
  await addMessageToHistory(taskId, ctx.user.organization_id, message);

  // Process the message
  const result = await processA2AMessage(task, message, ctx, configuration);

  return result;
}

/**
 * Process an A2A message and dispatch to appropriate skill
 */
async function processA2AMessage(
  task: Task,
  message: Message,
  ctx: A2AContext,
  _configuration?: MessageSendParams["configuration"],
): Promise<Task> {
  const textParts = message.parts.filter(
    (p): p is { type: "text"; text: string } => p.type === "text",
  );
  const dataParts = message.parts.filter(
    (p): p is { type: "data"; data: Record<string, unknown> } => p.type === "data",
  );

  const textContent = textParts.map((p) => p.text).join("\n");
  const dataContent = dataParts.length > 0 ? dataParts[0].data : {};

  // Check for explicit skill request
  const skillId = dataContent.skill as string | undefined;

  let responseMessage: Message;
  const artifacts: Artifact[] = [];

  // Dispatch to appropriate skill
  if (skillId === "chat_completion" || (textContent && !skillId)) {
    const result = await executeSkillChatCompletion(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [createTextPart(result.content)]);
    artifacts.push(
      createArtifact(
        [
          createDataPart({
            model: result.model,
            usage: result.usage,
            cost: result.cost,
          }),
        ],
        "usage",
        "Token usage and cost information",
      ),
    );
  } else if (skillId === "image_generation") {
    const result = await executeSkillImageGeneration(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [
      {
        type: "file",
        file: { bytes: result.image.split(",")[1], mimeType: result.mimeType },
      },
    ]);
    artifacts.push(
      createArtifact([createDataPart({ cost: result.cost })], "cost", "Generation cost"),
    );
  } else if (skillId === "chat_with_agent") {
    const result = await executeSkillChatWithAgent(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [createTextPart(result.response)]);
  } else if (skillId === "web_search") {
    const result = await executeSkillWebSearch(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "extract_page") {
    const result = await executeSkillExtractPage(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "browser_session") {
    const result = await executeSkillBrowserSession(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "list_agents") {
    const result = await executeSkillListAgents(dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "check_balance") {
    const result = await executeSkillCheckBalance(ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "get_usage") {
    const result = await executeSkillGetUsage(dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "save_memory") {
    const result = await executeSkillSaveMemory(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "retrieve_memories") {
    const result = await executeSkillRetrieveMemories(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "list_containers") {
    const result = await executeSkillListContainers(dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "create_conversation") {
    const result = await executeSkillCreateConversation(dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "delete_memory") {
    const result = await executeSkillDeleteMemory(dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "get_conversation_context") {
    const result = await executeSkillGetConversationContext(dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "video_generation" || skillId === "generate_video") {
    const result = await executeSkillVideoGeneration(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else if (skillId === "get_user_profile" || skillId === "profile") {
    const result = await executeSkillGetUserProfile(ctx);
    responseMessage = createMessage("agent", [createDataPart(result)]);
  } else {
    // Default: treat as chat completion
    const result = await executeSkillChatCompletion(textContent, dataContent, ctx);
    responseMessage = createMessage("agent", [createTextPart(result.content)]);
  }

  // Update task in store with response
  await addMessageToHistory(task.id, ctx.user.organization_id, responseMessage);
  for (const artifact of artifacts) {
    await addArtifactToTask(task.id, ctx.user.organization_id, artifact);
  }

  // Update state and get the fully updated task from store
  const updatedTask = await updateTaskState(
    task.id,
    ctx.user.organization_id,
    "completed",
    responseMessage,
  );

  // Return the updated task from store (includes history and artifacts)
  if (updatedTask) {
    return updatedTask;
  }

  // Fallback to local task if store update failed
  task.status = createTaskStatus("completed", responseMessage);
  return task;
}

/**
 * tasks/get - Get task status and history
 */
export async function handleTasksGet(params: TaskGetParams, ctx: A2AContext): Promise<Task> {
  const { id, historyLength } = params;

  const store = await getTaskStore(id, ctx.user.organization_id);
  if (!store) {
    throw new Error(`Task not found: ${id}`);
  }

  const task = { ...store.task };

  if (historyLength !== undefined && task.history) {
    task.history = task.history.slice(-historyLength);
  }

  return task;
}

/**
 * tasks/cancel - Cancel a running task
 */
export async function handleTasksCancel(params: TaskCancelParams, ctx: A2AContext): Promise<Task> {
  const { id } = params;

  const store = await getTaskStore(id, ctx.user.organization_id);
  if (!store) {
    throw new Error(`Task not found: ${id}`);
  }

  const terminalStates: TaskState[] = ["completed", "canceled", "failed", "rejected"];
  if (terminalStates.includes(store.task.status.state)) {
    throw new Error(`Task ${id} is already in terminal state: ${store.task.status.state}`);
  }

  const task = await updateTaskState(id, ctx.user.organization_id, "canceled");
  if (!task) {
    throw new Error(`Failed to update task: ${id}`);
  }

  return task;
}

/**
 * Available skills for service discovery
 */
export const AVAILABLE_SKILLS = [
  { id: "chat_completion", description: "Generate text with LLMs" },
  {
    id: "web_search",
    description: "Search the web with hosted Google-grounded Gemini search",
  },
  {
    id: "extract_page",
    description: "Extract page content through the hosted Firecrawl extract API",
  },
  {
    id: "browser_session",
    description: "Create, inspect, and control hosted cloud browser sessions",
  },
  { id: "image_generation", description: "Generate images" },
  { id: "video_generation", description: "Generate videos (async)" },
  { id: "check_balance", description: "Check credit balance" },
  { id: "get_usage", description: "Get usage statistics" },
  { id: "list_agents", description: "List available agents" },
  {
    id: "chat_with_agent",
    description: "Chat with agent (requires agentId or roomId)",
  },
  { id: "save_memory", description: "Save a memory (requires roomId)" },
  { id: "retrieve_memories", description: "Retrieve memories by query" },
  { id: "delete_memory", description: "Delete a memory (requires memoryId)" },
  {
    id: "create_conversation",
    description: "Create a new conversation (requires title)",
  },
  {
    id: "get_conversation_context",
    description: "Get conversation details (requires conversationId)",
  },
  { id: "list_containers", description: "List deployed containers" },
  { id: "get_user_profile", description: "Get current user profile" },
] as const;
