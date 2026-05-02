import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { LanguageModel } from "ai";

type ModelProvider = "anthropic" | "google";

const ANTHROPIC_DEFAULT_REGION = "us-east5";
const GOOGLE_DEFAULT_REGION = "us-central1";

export function detectProvider(modelName: string): ModelProvider {
  return modelName.toLowerCase().startsWith("gemini") ? "google" : "anthropic";
}

function getProjectId(runtime: IAgentRuntime): string {
  const projectId =
    String(runtime.getSetting("GOOGLE_VERTEX_PROJECT_ID") ?? "") ||
    process.env.GOOGLE_VERTEX_PROJECT_ID;

  if (!projectId) {
    throw new Error(
      "GOOGLE_VERTEX_PROJECT_ID is required for the Vertex AI plugin",
    );
  }
  return projectId;
}

function getRegion(runtime: IAgentRuntime, provider: ModelProvider): string {
  const explicit =
    String(runtime.getSetting("GOOGLE_VERTEX_REGION") ?? "") ||
    process.env.GOOGLE_VERTEX_REGION;
  if (explicit) return explicit;
  return provider === "google"
    ? GOOGLE_DEFAULT_REGION
    : ANTHROPIC_DEFAULT_REGION;
}

export function createVertexClient(runtime: IAgentRuntime) {
  const project = getProjectId(runtime);
  const location = getRegion(runtime, "anthropic");
  logger.debug(
    `[Vertex] Anthropic client: project=${project} region=${location}`,
  );
  return createVertexAnthropic({ project, location });
}

export function createGoogleClient(runtime: IAgentRuntime) {
  const project = getProjectId(runtime);
  const location = getRegion(runtime, "google");
  logger.debug(`[Vertex] Google client: project=${project} region=${location}`);
  return createVertex({ project, location });
}

export function createModelForName(runtime: IAgentRuntime, modelName: string): LanguageModel {
  const provider = detectProvider(modelName);
  if (provider === "google") {
    return createGoogleClient(runtime)(modelName);
  }
  return createVertexClient(runtime)(modelName);
}
