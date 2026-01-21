/**
 * Direct Groq LLM calls
 *
 * Supports Groq models for fast inference.
 * All LLM calls are automatically logged to trajectory logger if available.
 *
 * IMPORTANT FOR RL TRAINING:
 * - When runtime is provided, trajectory context is automatically extracted
 * - Every LLM call is logged with EXACT input/output for training data
 * - Purpose field tracks call type: action, reasoning, evaluation, response
 */

import { createGroq } from "@ai-sdk/groq";
import type { IAgentRuntime } from "@elizaos/core";
import { generateText } from "ai";
import { getTrajectoryContext } from "../plugins/plugin-trajectory-logger/src/action-interceptor";
import type { TrajectoryLoggerService } from "../plugins/plugin-trajectory-logger/src/TrajectoryLoggerService";
import { isPromptLoggingEnabled, logPrompt } from "../utils/prompt-logger";

export async function callGroqDirect(params: {
  prompt: string;
  system?: string;
  modelSize?: "small" | "large";
  temperature?: number;
  maxTokens?: number;
  trajectoryLogger?: TrajectoryLoggerService;
  trajectoryId?: string;
  purpose?: "action" | "reasoning" | "evaluation" | "response" | "other";
  actionType?: string;
  runtime?: IAgentRuntime; // Pass runtime to access settings
}): Promise<string> {
  // Auto-extract trajectory context from runtime if not explicitly provided
  // This ensures ALL LLM calls are logged for RL training
  let trajectoryLogger = params.trajectoryLogger;
  let trajectoryId = params.trajectoryId;

  if (!trajectoryLogger && !trajectoryId && params.runtime) {
    const context = getTrajectoryContext(params.runtime);
    if (context) {
      trajectoryLogger = context.logger;
      trajectoryId = context.trajectoryId;
    }
  }

  // Use Groq models
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not set");
  }

  const groq = createGroq({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });

  // Model selection: Use Kimi K2 for agent decisions (excellent reasoning)
  const model = "moonshotai/kimi-k2-instruct-0905";

  const startTime = Date.now();

  // Add timeout to prevent hanging (60 seconds default, configurable)
  const timeoutMs = params.maxTokens && params.maxTokens < 500 ? 20000 : 60000; // Shorter timeout for small outputs

  const result = await Promise.race([
    generateText({
      model: groq.languageModel(model),
      prompt: params.prompt,
      system: params.system,
      temperature: params.temperature ?? 0.7,
      maxOutputTokens: params.maxTokens ?? 8192,
      maxRetries: 2,
      experimental_telemetry: { isEnabled: false },
    }),
    new Promise<{ text: string }>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`LLM call timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);

  const latencyMs = Date.now() - startTime;

  // Log to trajectory if available (CRITICAL for RL training data collection)
  if (trajectoryLogger && trajectoryId) {
    const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
    if (stepId) {
      trajectoryLogger.logLLMCall(stepId, {
        model,
        systemPrompt: params.system || "",
        userPrompt: params.prompt,
        response: result.text,
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        purpose: params.purpose || "action",
        actionType: params.actionType,
        latencyMs,
        promptTokens: undefined, // Token counts not available from Groq SDK
        completionTokens: undefined,
      });
    }
  }

  if (isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: params.actionType || params.purpose || "groq_direct",
      input: `System: ${params.system || ""}\n\nUser: ${params.prompt}`,
      output: result.text,
      metadata: {
        provider: "groq",
        model,
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
      },
    });
  }

  return result.text;
}
