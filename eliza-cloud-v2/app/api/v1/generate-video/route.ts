import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { fal } from "@fal-ai/client";
import type { QueueStatus } from "@fal-ai/client";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { usageService } from "@/lib/services/usage";
import { generationsService } from "@/lib/services/generations";
import { discordService } from "@/lib/services/discord";
import {
  VIDEO_GENERATION_COST,
  VIDEO_GENERATION_FALLBACK_COST,
} from "@/lib/pricing";
import { uploadFromUrl, isFalAiUrl } from "@/lib/blob";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";

fal.config({
  proxyUrl: "/api/fal/proxy",
});

export const maxDuration = 300;

interface VideoGenerationRequest {
  prompt: string;
  model?: string;
}

import type { FalVideoData } from "@/lib/types/video";

const VALID_MODELS = [
  "fal-ai/veo3",
  "fal-ai/veo3/fast",
  "fal-ai/kling-video/v2.1/master/text-to-video",
  "fal-ai/kling-video/v2.1/pro/text-to-video",
  "fal-ai/kling-video/v2.1/standard/text-to-video",
  "fal-ai/minimax/hailuo-02/standard/text-to-video",
  "fal-ai/minimax/hailuo-02/pro/text-to-video",
];

/**
 * POST /api/v1/generate-video
 * Generates videos using Fal.ai video generation models.
 * Requires authentication with organization.
 *
 * @param request - Request body with prompt and optional model selection.
 * @returns Video generation job details and status.
 */
async function handlePOST(request: NextRequest) {
  let generationId: string | undefined;
  try {
    const { user, apiKey, session_token } =
      await requireAuthOrApiKeyWithOrg(request);

    if (!process.env.FAL_KEY) {
      logger.error("[VIDEO GENERATION] FAL_KEY is not configured");
      return NextResponse.json(
        { error: "Video generation service is not configured" },
        { status: 503 },
      );
    }

    const body: VideoGenerationRequest = await request.json();
    const { prompt, model = "fal-ai/veo3" } = body;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return NextResponse.json(
        { error: "Prompt is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    if (model && !VALID_MODELS.includes(model)) {
      return NextResponse.json(
        {
          error: "Invalid model specified",
          validModels: VALID_MODELS,
        },
        { status: 400 },
      );
    }

    // Reserve credits BEFORE generation
    let reservation: CreditReservation;
    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id!,
        amount: VIDEO_GENERATION_COST,
        userId: user.id,
        description: `Video generation: ${model}`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return NextResponse.json(
          {
            error: "Insufficient credits for video generation",
            required: error.required,
          },
          { status: 402 },
        );
      }
      throw error;
    }

    const generation = await generationsService.create({
      organization_id: user.organization_id!!,
      user_id: user.id,
      api_key_id: apiKey?.id || null,
      type: "video",
      model: model,
      provider: "fal",
      prompt: prompt.trim(),
      status: "pending",
      credits: String(VIDEO_GENERATION_COST),
      cost: String(VIDEO_GENERATION_COST),
    });

    generationId = generation.id;

    const result = await fal.subscribe(model, {
      input: {
        prompt: prompt.trim(),
      },
      logs: true,
    });

    const data = result.data as FalVideoData;

    if (!data?.video?.url) {
      logger.error("[VIDEO GENERATION] No video URL in response:", data);
      // Reconcile with 0 cost (full refund)
      await reservation.reconcile(0);
      return NextResponse.json(
        { error: "No video URL was returned from the generation service" },
        { status: 500 },
      );
    }

    // Upload video to Vercel Blob (required - we don't expose Fal.ai URLs)
    let blobUrl: string;
    let blobFileSize: bigint | null = null;

    const fileExtension =
      data.video.content_type?.split("/")[1] ||
      data.video.file_name?.split(".").pop() ||
      "mp4";

    try {
      // Always upload to our storage - videos come from Fal.ai
      if (!isFalAiUrl(data.video.url)) {
        // If for some reason it's not a Fal.ai URL, log a warning but still upload
        console.warn(
          `[VIDEO GENERATION] Unexpected non-Fal.ai URL: ${data.video.url}`,
        );
      }

      const uploadResult = await uploadFromUrl(data.video.url, {
        filename: `${generationId}.${fileExtension}`,
        contentType: data.video.content_type || "video/mp4",
        folder: "videos",
        userId: user.id,
      });

      blobUrl = uploadResult.url;
      blobFileSize = BigInt(uploadResult.size);
    } catch (blobError) {
      logger.error(
        "[VIDEO GENERATION] Failed to upload to Vercel Blob:",
        blobError,
      );
      // Reconcile with 0 cost (full refund) - video generated but storage failed
      await reservation.reconcile(0);
      return NextResponse.json(
        { error: "Failed to store video in our storage. Please try again." },
        { status: 500 },
      );
    }

    // Reconcile with actual cost (video successfully generated and stored)
    await reservation.reconcile(VIDEO_GENERATION_COST);
    logger.info("[VIDEO GENERATION] Credits reconciled", {
      reserved: reservation.reservedAmount,
      actual: VIDEO_GENERATION_COST,
    });

    const usageRecord = await usageService.create({
      organization_id: user.organization_id!!,
      user_id: user.id,
      api_key_id: apiKey?.id || null,
      type: "video",
      model: model,
      provider: "fal",
      input_tokens: 0,
      output_tokens: 0,
      input_cost: String(VIDEO_GENERATION_COST),
      output_cost: String(0),
      is_successful: true,
    });

    if (generationId) {
      await generationsService.update(generationId, {
        status: "completed",
        storage_url: blobUrl,
        mime_type: data.video.content_type || "video/mp4",
        file_size: blobFileSize,
        dimensions: {
          width: data.video.width,
          height: data.video.height,
        },
        usage_record_id: usageRecord.id,
        completed_at: new Date(),
        result: {
          video: {
            url: blobUrl,
            content_type: data.video.content_type,
            width: data.video.width,
            height: data.video.height,
          },
          // Note: Original Fal.ai URL stored separately for debugging only, not exposed to clients
          _originalUrl: data.video.url,
          seed: data.seed,
          has_nsfw_concepts: data.has_nsfw_concepts,
          timings: data.timings,
          requestId: result.requestId,
        },
      });

      // Send Discord notification for video generation (non-blocking)
      discordService
        .logVideoGenerated({
          generationId,
          prompt: prompt.trim(),
          videoUrl: blobUrl,
          userId: user.id,
          organizationId: user.organization_id!,
          model,
          width: data.video.width,
          height: data.video.height,
          fileSize: blobFileSize ? Number(blobFileSize) : undefined,
          cost: VIDEO_GENERATION_COST,
        })
        .catch((err) => {
          logger.warn(
            "[VIDEO GENERATION] Failed to send Discord notification",
            {
              generationId,
              error: err instanceof Error ? err.message : "Unknown error",
            },
          );
        });
    }

    return NextResponse.json(
      {
        video: {
          url: blobUrl,
          content_type: data.video.content_type,
          width: data.video.width,
          height: data.video.height,
          file_name: data.video.file_name,
          file_size: blobFileSize ? Number(blobFileSize) : undefined,
        },
        // Note: Original Fal.ai URL is NOT exposed to the client
        seed: data.seed,
        has_nsfw_concepts: data.has_nsfw_concepts,
        timings: data.timings,
        requestId: result.requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logger.error("[VIDEO GENERATION] Error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";

    // If reservation was made, reconcile with fallback cost (partial charge for attempt)
    // @ts-expect-error - reservation may not be defined if error occurred before reservation
    if (typeof reservation !== "undefined") {
      // @ts-expect-error - reservation is defined at this point
      await reservation.reconcile(VIDEO_GENERATION_FALLBACK_COST);
      logger.info("[VIDEO GENERATION] Credits reconciled with fallback cost", {
        fallbackCost: VIDEO_GENERATION_FALLBACK_COST,
      });
    }

    try {
      const { user: fallbackUser, apiKey: fallbackApiKey } =
        await requireAuthOrApiKeyWithOrg(request);

      const fallbackUsageRecord = await usageService.create({
        organization_id: fallbackUser.organization_id,
        user_id: fallbackUser.id,
        api_key_id: fallbackApiKey?.id || null,
        type: "video",
        model: "fal-ai/veo3",
        provider: "fal",
        input_tokens: 0,
        output_tokens: 0,
        input_cost: String(VIDEO_GENERATION_FALLBACK_COST),
        output_cost: String(0),
        is_successful: false,
        error_message: errorMessage,
      });

      if (generationId) {
        await generationsService.update(generationId, {
          status: "failed",
          error: errorMessage,
          storage_url: null,
          mime_type: "video/mp4",
          dimensions: {
            width: 1920,
            height: 1080,
          },
          credits: String(VIDEO_GENERATION_FALLBACK_COST),
          cost: String(VIDEO_GENERATION_FALLBACK_COST),
          usage_record_id: fallbackUsageRecord.id,
          completed_at: new Date(),
          result: {
            isFallback: true,
            originalError: errorMessage,
            video: null,
          },
        });
      }
    } catch (authError) {
      logger.error(
        "[VIDEO GENERATION] Auth error during fallback logging:",
        authError,
      );
    }

    return NextResponse.json(
      {
        error: "Video generation failed. Please try again.",
        isFallback: true,
        originalError: errorMessage,
      },
      { status: 500 },
    );
  }
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.CRITICAL);
