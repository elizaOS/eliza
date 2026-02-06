/**
 * Generation MCP tools
 * Tools for text, image, video, embeddings, TTS, and prompts generation
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { streamText } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { logger } from "@/lib/utils/logger";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { generationsService } from "@/lib/services/generations";
import { contentModerationService } from "@/lib/services/content-moderation";
import { getElevenLabsService } from "@/lib/services/elevenlabs";
import {
  calculateCost,
  getProviderFromModel,
  IMAGE_GENERATION_COST,
} from "@/lib/pricing";
import { uploadBase64Image } from "@/lib/blob";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return Buffer.from(combined.buffer, combined.byteOffset, combined.byteLength);
}

export function registerGenerationTools(server: McpServer): void {
  // Generate Text - Generate text using AI models
  server.registerTool(
    "generate_text",
    {
      description:
        "Generate text using AI models (GPT-4, Claude, Gemini). Deducts credits based on token usage.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(10000)
          .describe("The text prompt to generate from"),
        model: z
          .enum([
            "gpt-4o",
            "gpt-4o-mini",
            "claude-3-5-sonnet-20241022",
            "gemini-2.0-flash-exp",
          ])
          .optional()
          .default("gpt-4o")
          .describe("The AI model to use for generation"),
        maxLength: z
          .number()
          .int()
          .min(1)
          .max(4000)
          .optional()
          .default(1000)
          .describe("Maximum length of generated text"),
      },
    },
    async ({ prompt, model = "gpt-4o", maxLength = 1000 }) => {
      let generationId: string | undefined;
      let reservation: CreditReservation | null = null;

      try {
        const { user, apiKey } = getAuthContext();

        // Check if user is blocked due to moderation violations
        if (await contentModerationService.shouldBlockUser(user.id)) {
          return errorResponse("Account suspended due to policy violations");
        }

        // Start async moderation (doesn't block)
        contentModerationService.moderateInBackground(
          prompt,
          user.id,
          undefined,
          (result) => {
            logger.warn("[MCP] generate_text moderation violation", {
              userId: user.id,
              categories: result.flaggedCategories,
              action: result.action,
            });
          },
        );

        const provider = getProviderFromModel(model);

        // Reserve credits BEFORE generation
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            model,
            provider,
            estimatedInputTokens: Math.ceil(prompt.length / 4),
            estimatedOutputTokens: Math.min(maxLength, 500),
            userId: user.id,
            description: `MCP text generation: ${model}`,
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse("Insufficient balance", {
              required: error.required,
            });
          }
          throw error;
        }

        // Create generation record
        const generation = await generationsService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKey?.id || null,
          type: "chat",
          model,
          provider,
          prompt,
          status: "pending",
          credits: String(reservation?.reservedAmount ?? 0),
          cost: String(reservation?.reservedAmount ?? 0),
        });

        generationId = generation.id;

        // Generate text (non-streaming for MCP)
        const result = await streamText({
          model: gateway.languageModel(model),
          prompt,
        });

        let fullText = "";
        for await (const delta of result.textStream) {
          fullText += delta;
          if (fullText.length >= maxLength) {
            fullText = fullText.substring(0, maxLength);
            break;
          }
        }

        const usage = await result.usage;

        // Calculate actual cost
        const { inputCost, outputCost, totalCost } = await calculateCost(
          model,
          provider,
          usage?.inputTokens || 0,
          usage?.outputTokens || 0,
        );

        // Reconcile credits
        await reservation?.reconcile(totalCost);

        // Create usage record
        const usageRecord = await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKey?.id || null,
          type: "chat",
          model,
          provider,
          input_tokens: usage?.inputTokens || 0,
          output_tokens: usage?.outputTokens || 0,
          input_cost: String(inputCost),
          output_cost: String(outputCost),
          is_successful: true,
        });

        // Update generation record
        await generationsService.update(generationId, {
          status: "completed",
          content: fullText,
          tokens: (usage?.inputTokens || 0) + (usage?.outputTokens || 0),
          cost: String(totalCost),
          credits: String(totalCost),
          usage_record_id: usageRecord.id,
          completed_at: new Date(),
          result: {
            text: fullText,
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            totalTokens: usage?.totalTokens,
          },
        });

        return {
          content: [{ type: "text" as const, text: fullText }],
        };
      } catch (error) {
        try {
          await reservation?.reconcile(0);
        } catch (refundError) {
          logger.error("Failed to refund credits:", refundError);
        }

        if (generationId) {
          try {
            await generationsService.update(generationId, {
              status: "failed",
              error:
                error instanceof Error ? error.message : "Generation failed",
              completed_at: new Date(),
            });
          } catch (updateError) {
            logger.error("Failed to update generation record:", updateError);
          }
        }

        return errorResponse(
          error instanceof Error ? error.message : "Text generation failed",
        );
      }
    },
  );

  // Generate Image - Generate images using Gemini
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate images using Google Gemini 2.5. Deducts credits per image generated.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(5000)
          .describe("Description of the image to generate"),
        aspectRatio: z
          .enum(["1:1", "16:9", "9:16", "4:3", "3:4"])
          .optional()
          .default("1:1")
          .describe("Aspect ratio for the generated image"),
      },
    },
    async ({ prompt, aspectRatio = "1:1" }) => {
      let generationId: string | undefined;
      let reservation: CreditReservation | null = null;

      try {
        const { user, apiKey } = getAuthContext();

        if (await contentModerationService.shouldBlockUser(user.id)) {
          return errorResponse("Account suspended due to policy violations");
        }

        contentModerationService.moderateInBackground(
          prompt,
          user.id,
          undefined,
          (result) => {
            logger.warn("[MCP] generate_image moderation violation", {
              userId: user.id,
              categories: result.flaggedCategories,
              action: result.action,
            });
          },
        );

        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: IMAGE_GENERATION_COST,
            userId: user.id,
            description: "MCP image generation: google/gemini-2.5-flash-image",
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            return errorResponse("Insufficient balance", {
              required: error.required,
            });
          }
          throw error;
        }

        const generation = await generationsService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKey?.id || null,
          type: "image",
          model: "google/gemini-2.5-flash-image",
          provider: "google",
          prompt,
          status: "pending",
          credits: String(IMAGE_GENERATION_COST),
          cost: String(IMAGE_GENERATION_COST),
        });

        generationId = generation.id;

        const aspectRatioDescriptions: Record<string, string> = {
          "1:1": "square composition",
          "16:9": "wide landscape composition",
          "9:16": "tall portrait composition",
          "4:3": "landscape composition",
          "3:4": "portrait composition",
        };

        const enhancedPrompt = `${prompt}, ${aspectRatioDescriptions[aspectRatio]}`;

        const result = streamText({
          model: "google/gemini-2.5-flash-image",
          providerOptions: {
            google: { responseModalities: ["TEXT", "IMAGE"] },
          },
          prompt: `Generate an image: ${enhancedPrompt}`,
        });

        let imageBase64: string | null = null;
        let textResponse = "";
        let mimeType = "image/png";

        for await (const delta of result.fullStream) {
          switch (delta.type) {
            case "text-delta": {
              textResponse += delta.text;
              break;
            }
            case "file": {
              if (delta.file.mediaType.startsWith("image/")) {
                const uint8Array = delta.file.uint8Array;
                const base64 = Buffer.from(uint8Array).toString("base64");
                mimeType = delta.file.mediaType || "image/png";
                imageBase64 = `data:${mimeType};base64,${base64}`;
              }
              break;
            }
          }
        }

        if (!imageBase64) {
          await reservation?.reconcile(0);

          const usageRecord = await usageService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            api_key_id: apiKey?.id || null,
            type: "image",
            model: "google/gemini-2.5-flash-image",
            provider: "google",
            input_tokens: 0,
            output_tokens: 0,
            input_cost: String(0),
            output_cost: String(0),
            is_successful: false,
            error_message: "No image was generated",
          });

          if (generationId) {
            await generationsService.update(generationId, {
              status: "failed",
              error: "No image was generated",
              usage_record_id: usageRecord.id,
              completed_at: new Date(),
            });
          }

          return errorResponse("No image was generated");
        }

        const usageRecord = await usageService.create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKey?.id || null,
          type: "image",
          model: "google/gemini-2.5-flash-image",
          provider: "google",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(IMAGE_GENERATION_COST),
          output_cost: String(0),
          is_successful: true,
        });

        let blobUrl = imageBase64;
        let fileSize: bigint | null = null;

        try {
          const fileExtension = mimeType.split("/")[1] || "png";
          const blobResult = await uploadBase64Image(imageBase64, {
            filename: `${generationId}.${fileExtension}`,
            folder: "images",
            userId: user.id,
          });
          blobUrl = blobResult.url;
          fileSize = blobResult.size ? BigInt(blobResult.size) : null;
        } catch (blobError) {
          logger.error("Failed to upload to Vercel Blob:", blobError);
        }

        await reservation?.reconcile(IMAGE_GENERATION_COST);

        await generationsService.update(generationId, {
          status: "completed",
          content: imageBase64,
          storage_url: blobUrl,
          mime_type: mimeType,
          file_size: fileSize,
          usage_record_id: usageRecord.id,
          completed_at: new Date(),
          result: { aspectRatio, textResponse },
        });

        return jsonResponse({
          message: "Image generated successfully",
          url: blobUrl !== imageBase64 ? blobUrl : undefined,
          aspectRatio,
          cost: String(IMAGE_GENERATION_COST),
        });
      } catch (error) {
        try {
          await reservation?.reconcile(0);
        } catch (refundError) {
          logger.error("Failed to refund credits:", refundError);
        }

        if (generationId) {
          try {
            await generationsService.update(generationId, {
              status: "failed",
              error:
                error instanceof Error ? error.message : "Generation failed",
              completed_at: new Date(),
            });
          } catch (updateError) {
            logger.error("Failed to update generation record:", updateError);
          }
        }

        return errorResponse(
          error instanceof Error ? error.message : "Image generation failed",
        );
      }
    },
  );

  // Generate Video
  server.registerTool(
    "generate_video",
    {
      description: "Generate a video using AI models. Cost: $5 per video",
      inputSchema: {
        prompt: z.string().describe("Video generation prompt"),
        model: z
          .string()
          .optional()
          .default("fal-ai/veo3")
          .describe("Model to use for generation"),
      },
    },
    async ({ prompt, model }) => {
      try {
        const { user, apiKey } = getAuthContext();
        const VIDEO_COST = 5;

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: VIDEO_COST,
            userId: user.id,
            description: `MCP video generation: ${model}`,
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            throw new Error(
              `Insufficient credits: need $${VIDEO_COST.toFixed(2)}`,
            );
          }
          throw error;
        }

        let generation;
        try {
          generation = await generationsService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            api_key_id: apiKey?.id || null,
            type: "video",
            model,
            provider: "fal",
            prompt,
            status: "pending",
            credits: String(VIDEO_COST),
            cost: String(VIDEO_COST),
          });
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(VIDEO_COST);

        return jsonResponse({
          success: true,
          jobId: generation.id,
          status: "pending",
          cost: VIDEO_COST,
          message:
            "Video generation started. Poll /api/v1/gallery to check status.",
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to generate video",
        );
      }
    },
  );

  // Text to Speech
  server.registerTool(
    "text_to_speech",
    {
      description: "Convert text to speech audio. Cost: ~$0.001 per 100 chars",
      inputSchema: {
        text: z.string().max(5000).describe("Text to convert to speech"),
        voiceId: z.string().optional().describe("ElevenLabs voice ID"),
      },
    },
    async ({ text, voiceId }) => {
      try {
        const { user } = getAuthContext();
        const TTS_COST = 0.001 * Math.ceil(text.length / 100);

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: TTS_COST,
            userId: user.id,
            description: "MCP text-to-speech",
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            throw new Error("Insufficient credits");
          }
          throw error;
        }

        let audioUrl;
        try {
          const elevenLabs = await getElevenLabsService();
          const audioStream = await elevenLabs.textToSpeech({
            text,
            voiceId: voiceId || "21m00Tcm4TlvDq8ikWAM",
          });
          const audioBuffer = await streamToBuffer(audioStream);
          const { uploadFromBuffer } = await import("@/lib/blob");
          audioUrl = await uploadFromBuffer(
            audioBuffer,
            `tts-${Date.now()}.mp3`,
            "audio/mpeg",
          );
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(TTS_COST);

        return jsonResponse({
          success: true,
          audioUrl,
          format: "mp3",
          cost: TTS_COST,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to generate speech",
        );
      }
    },
  );

  // List Voices
  server.registerTool(
    "list_voices",
    {
      description: "List available TTS voices. FREE tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const elevenLabs = await getElevenLabsService();
        const voices = await elevenLabs.getVoices();

        return jsonResponse({
          success: true,
          voices: voices.map((v) => ({
            id: v.voiceId,
            name: v.name ?? "Unnamed voice",
            category: v.category ?? "premade",
          })),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to list voices",
        );
      }
    },
  );

  // Generate Prompts
  server.registerTool(
    "generate_prompts",
    {
      description: "Generate AI agent concept prompts. Cost: ~$0.01",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const COST = 0.01;

        let reservation: CreditReservation | null = null;
        try {
          reservation = await creditsService.reserve({
            organizationId: user.organization_id,
            amount: COST,
            userId: user.id,
            description: "MCP prompt generation",
          });
        } catch (error) {
          if (error instanceof InsufficientCreditsError) {
            throw new Error("Insufficient credits");
          }
          throw error;
        }

        let prompts;
        try {
          const { openai } = await import("@ai-sdk/openai");
          const { generateText } = await import("ai");

          const { text } = await generateText({
            model: openai("gpt-4o-mini"),
            prompt: `Generate 4 short, practical AI agent concepts (max 8 words each). Return ONLY a JSON array of strings.`,
          });

          prompts = JSON.parse(text);
        } catch (opError) {
          await reservation?.reconcile(0);
          throw opError;
        }

        await reservation?.reconcile(COST);

        return jsonResponse({ success: true, prompts, cost: COST });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to generate prompts",
        );
      }
    },
  );
}
