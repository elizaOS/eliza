/**
 * A2A Client Integration for Eliza Agents
 *
 * Uses @a2a-js/sdk client for A2A communication
 */

import type { AgentCard, Message, Task } from "@a2a-js/sdk";
import { A2AClient } from "@a2a-js/sdk/client";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "../../shared/logger";

export interface FeedA2ARuntime extends IAgentRuntime {
  feedA2AClient?: A2AClient;
  feedAgentCard?: AgentCard;
}

/**
 * Initialize A2A client for Feed
 */
export async function initializeA2AClient(
  endpoint?: string,
  apiKey?: string,
): Promise<A2AClient> {
  const feedEndpoint =
    endpoint ||
    process.env.FEED_A2A_ENDPOINT ||
    `${process.env.NEXT_PUBLIC_APP_URL}/.well-known/agent-card.json` ||
    "http://localhost:3000/.well-known/agent-card.json";

  // Get API key from parameter or environment
  const effectiveApiKey = apiKey || process.env.FEED_A2A_API_KEY;

  logger.info("Initializing A2A client for Feed", {
    endpoint: feedEndpoint,
    hasApiKey: !!effectiveApiKey,
  });

  // Create custom fetch that includes API key header for authentication
  const authenticatedFetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);

    // Add API key for A2A authentication
    if (effectiveApiKey) {
      headers.set("x-feed-api-key", effectiveApiKey);
    }

    return fetch(url, { ...init, headers });
  };

  // Use SDK to create client from agent card with authenticated fetch
  const client = await A2AClient.fromCardUrl(feedEndpoint, {
    fetchImpl: authenticatedFetch,
  } as Parameters<typeof A2AClient.fromCardUrl>[1]);

  // Validate Feed capabilities
  const card = await client.getAgentCard();

  if (card.protocolVersion !== "0.3.0") {
    logger.warn("Feed using non-standard A2A protocol version", {
      expected: "0.3.0",
      actual: card.protocolVersion,
    });
  }

  logger.info("A2A client initialized successfully", {
    name: card.name,
    skills: card.skills.length,
    transport: card.preferredTransport,
    protocolVersion: card.protocolVersion,
  });

  return client;
}

/**
 * Execute a Feed skill via A2A protocol
 *
 * @param client - A2AClient instance
 * @param skillId - Feed skill ID (e.g., 'prediction-market-trader')
 * @param message - Natural language message or structured JSON
 * @returns Task or Message response
 */
export async function executeFeedSkill(
  client: A2AClient,
  skillId: string,
  message: string,
): Promise<Task | Message> {
  logger.info("Executing Feed skill via A2A", {
    skillId,
    messageLength: message.length,
  });

  const response = await client.sendMessage({
    message: {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "user",
      parts: [
        {
          kind: "text",
          text: message,
          metadata: {
            skillId, // Hint which skill to use
          },
        },
      ],
    },
  });

  // Handle SendMessageResponse - extract Task or Message from result
  // Type guard to check if response is Task or Message
  function isTaskOrMessage(obj: object): obj is Task | Message {
    return "kind" in obj && (obj.kind === "task" || obj.kind === "message");
  }

  let result: Task | Message;
  if (
    "result" in response &&
    response.result !== null &&
    typeof response.result === "object" &&
    isTaskOrMessage(response.result)
  ) {
    result = response.result;
  } else if (
    typeof response === "object" &&
    response !== null &&
    isTaskOrMessage(response)
  ) {
    result = response;
  } else {
    throw new Error("Unexpected response format from sendMessage");
  }

  logger.info("Skill execution response received", {
    skillId,
    responseType: "kind" in result ? result.kind : "unknown",
  });

  return result;
}

// Type guard to check if response is Task
function isTask(obj: object): obj is Task {
  return "kind" in obj && obj.kind === "task";
}

// Type guard for GetTaskResponse result containing task
interface GetTaskResult {
  task: Task;
}

function hasTaskResult(obj: object): obj is GetTaskResult {
  return "task" in obj;
}

/**
 * Wait for task to complete (with polling)
 *
 * @param client - A2AClient instance
 * @param taskId - Task ID to poll
 * @param maxAttempts - Maximum polling attempts (default: 30)
 * @param intervalMs - Polling interval in ms (default: 1000)
 * @returns Completed task
 */
export async function waitForTaskCompletion(
  client: A2AClient,
  taskId: string,
  maxAttempts: number = 30,
  intervalMs: number = 1000,
): Promise<Task> {
  logger.info("Waiting for task completion", { taskId, maxAttempts });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await client.getTask({ id: taskId });

    // Extract task from response
    let task: Task;
    if (
      "result" in response &&
      response.result &&
      typeof response.result === "object" &&
      hasTaskResult(response.result)
    ) {
      task = response.result.task;
    } else if (isTask(response)) {
      task = response;
    } else {
      throw new Error("Invalid task response format");
    }

    const terminalStates = ["completed", "failed", "canceled", "rejected"];

    if (
      task.status &&
      "state" in task.status &&
      terminalStates.includes(task.status.state as string)
    ) {
      logger.info("Task reached terminal state", {
        taskId,
        state: task.status.state,
        attempts: attempt + 1,
      });
      return task;
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  logger.warn("Task did not complete within timeout", { taskId, maxAttempts });

  // Return last known state
  const response = await client.getTask({ id: taskId });

  if (
    "result" in response &&
    response.result &&
    typeof response.result === "object" &&
    hasTaskResult(response.result)
  ) {
    return response.result.task;
  }

  // If response itself is a Task (direct response format)
  if (isTask(response)) {
    return response;
  }

  throw new Error("Invalid task response format from getTask");
}

/**
 * Execute skill and wait for result
 *
 * Convenience method that executes a skill and waits for completion
 */
export async function executeAndWait(
  client: A2AClient,
  skillId: string,
  message: string,
): Promise<Task> {
  const response = await executeFeedSkill(client, skillId, message);

  if ("kind" in response && response.kind === "task") {
    const task = response as Task;
    return await waitForTaskCompletion(client, task.id);
  }

  // If direct message response, wrap it
  throw new Error("Expected task response, got direct message");
}

/**
 * Get available Feed skills from AgentCard
 */
export async function getFeedSkills(
  client: A2AClient,
): Promise<
  Array<{ id: string; name: string; description: string; examples: string[] }>
> {
  const card = await client.getAgentCard();

  return card.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    examples: skill.examples || [],
  }));
}
