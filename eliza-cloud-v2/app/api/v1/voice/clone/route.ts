/**
 * Voice Clone API (v1)
 *
 * POST /api/v1/voice/clone
 * Creates a new voice clone.
 * Supports both Privy session and API key authentication.
 *
 * WHY THIS EXISTS:
 * ----------------
 * 1. AUTOMATED VOICE CREATION: Content platforms, podcast tools, and accessibility
 *    services need to clone voices programmatically as part of onboarding flows.
 *
 * 2. BRANDED VOICE AGENTS: Organizations can programmatically create branded voices
 *    for their AI agents, ensuring consistent voice identity across applications.
 *
 * 3. PROVIDER AGNOSTIC: Generic path hides ElevenLabs specifics, allowing future
 *    provider changes without client-side modifications.
 *
 * CREDIT HANDLING:
 * - Credits reserved BEFORE cloning starts (prevents overcommitment)
 * - Credits refunded if cloning fails (via reservation.reconcile(0))
 * - Different pricing for instant vs professional cloning
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { voiceCloningService } from "@/lib/services/voice-cloning";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import {
  VOICE_CLONE_INSTANT_COST,
  VOICE_CLONE_PROFESSIONAL_COST,
} from "@/lib/pricing-constants";

const MAX_FILES = 10;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * POST /api/v1/voice/clone
 * Creates a new voice clone using the voice cloning service.
 * Supports both instant and professional cloning types with credit deduction.
 * Refunds credits if cloning fails.
 *
 * Request Body (FormData):
 * - `name`: Voice name (required).
 * - `description`: Optional voice description.
 * - `cloneType`: "instant" | "professional" (required).
 * - `settings`: Optional JSON string with voice settings.
 * - `file0`, `file1`, ...: Audio files for cloning (1-10 files, max 100MB total).
 *
 * @param request - FormData with voice configuration and audio files.
 * @returns Created voice details, job information, and credit deduction confirmation.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);

    const formData = await request.formData();

    const name = formData.get("name") as string;
    const description = formData.get("description") as string | undefined;
    const cloneType = formData.get("cloneType") as "instant" | "professional";
    const settingsStr = formData.get("settings") as string | undefined;

    if (!name || !cloneType) {
      return NextResponse.json(
        { error: "Missing required fields: name, cloneType" },
        { status: 400 },
      );
    }

    if (!["instant", "professional"].includes(cloneType)) {
      return NextResponse.json(
        { error: "Invalid cloneType. Must be 'instant' or 'professional'" },
        { status: 400 },
      );
    }

    const files: File[] = [];
    let totalSize = 0;

    for (const [key, value] of formData.entries()) {
      if (
        key.startsWith("file") &&
        typeof value === "object" &&
        value !== null &&
        "size" in value &&
        "name" in value
      ) {
        files.push(value as File);
        totalSize += (value as File).size;
      }
    }

    if (files.length === 0) {
      return NextResponse.json(
        { error: "At least one audio file is required" },
        { status: 400 },
      );
    }

    if (files.length > MAX_FILES) {
      return NextResponse.json(
        { error: `Maximum ${MAX_FILES} files allowed` },
        { status: 400 },
      );
    }

    if (totalSize > MAX_TOTAL_SIZE) {
      return NextResponse.json(
        { error: "Total file size exceeds 100MB limit" },
        { status: 400 },
      );
    }

    let settings: Record<string, unknown> = {};
    if (settingsStr) {
      try {
        settings = JSON.parse(settingsStr);
      } catch {
        return NextResponse.json(
          { error: "Invalid settings JSON" },
          { status: 400 },
        );
      }
    }

    logger.info(`[Voice Clone API] Creating ${cloneType} voice clone: ${name}`, {
      userId: user.id,
      organizationId: user.organization_id,
      fileCount: files.length,
      totalSize,
    });

    const cost =
      cloneType === "instant"
        ? VOICE_CLONE_INSTANT_COST
        : VOICE_CLONE_PROFESSIONAL_COST;

    let reservation: CreditReservation;
    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        amount: cost,
        userId: user.id,
        description: `Voice cloning (${cloneType}): ${name}`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        logger.warn("[Voice Clone API] Insufficient credits", {
          organizationId: user.organization_id,
          required: error.required,
        });
        return NextResponse.json(
          {
            error: "Insufficient balance",
            details: {
              required: error.required,
              cloneType,
            },
          },
          { status: 402 },
        );
      }
      throw error;
    }

    logger.info("[Voice Clone API] Credits reserved", {
      organizationId: user.organization_id,
      amount: cost,
    });

    try {
      const startTime = Date.now();
      const result = await voiceCloningService.createVoiceClone({
        organizationId: user.organization_id,
        userId: user.id,
        name,
        description,
        cloneType,
        files,
        settings,
      });
      const duration = Date.now() - startTime;

      logger.info("[Voice Clone API] Voice clone created successfully", {
        userVoiceId: result.userVoice.id,
        jobId: result.job.id,
        duration,
      });

      await reservation.reconcile(cost);

      (async () => {
        try {
          await usageService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            api_key_id: apiKey?.id ?? null,
            type: "voice_cloning",
            model: cloneType,
            provider: "elevenlabs",
            input_tokens: 0,
            output_tokens: 0,
            input_cost: String(cost),
            output_cost: String(0),
            is_successful: true,
            duration_ms: duration,
            metadata: {
              voiceName: name,
              fileCount: files.length,
              totalSize,
            },
          });
        } catch (error) {
          logger.error("[Voice Clone API] Failed to create usage record", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();

      return NextResponse.json(
        {
          success: true,
          voice: {
            id: result.userVoice.id,
            elevenlabsVoiceId: result.userVoice.elevenlabsVoiceId,
            name: result.userVoice.name,
            description: result.userVoice.description,
            cloneType: result.userVoice.cloneType,
            status: result.job.status,
            sampleCount: files.length,
            createdAt: result.userVoice.createdAt,
          },
          job: {
            id: result.job.id,
            status: result.job.status,
            progress: result.job.progress,
          },
          creditsDeducted: cost,
          estimatedCompletionTime:
            cloneType === "professional" ? "30-60 minutes" : "30 seconds",
        },
        { status: 201 },
      );
    } catch (error) {
      logger.error("[Voice Clone API] Error creating voice clone", {
        error: error instanceof Error ? error.message : "Unknown error",
      });

      await reservation.reconcile(0);

      logger.info("[Voice Clone API] Credits refunded via reconcile(0)", {
        organizationId: user.organization_id,
        amount: cost,
      });

      (async () => {
        try {
          await usageService.create({
            organization_id: user.organization_id,
            user_id: user.id,
            api_key_id: apiKey?.id ?? null,
            type: "voice_cloning",
            model: cloneType,
            provider: "elevenlabs",
            input_tokens: 0,
            output_tokens: 0,
            input_cost: String(0),
            output_cost: String(0),
            is_successful: false,
            error_message: error instanceof Error ? error.message : "Unknown error",
          });
        } catch (usageError) {
          logger.error("[Voice Clone API] Failed to record usage", {
            error:
              usageError instanceof Error ? usageError.message : "Unknown error",
          });
        }
      })();

      if (error instanceof Error) {
        if (error.message.includes("rate limit")) {
          return NextResponse.json(
            { error: "Rate limit exceeded. Please try again later." },
            { status: 429 },
          );
        }

        if (error.message.includes("quota")) {
          return NextResponse.json(
            {
              error:
                "Voice cloning service is temporarily unavailable due to high demand. Please try again shortly.",
              type: "service_unavailable",
              retryAfter: "1 hour",
            },
            { status: 503 },
          );
        }

        if (error.message.includes("professional_voice_limit_reached")) {
          return NextResponse.json(
            {
              error:
                "Professional voice limit reached. Delete an existing professional voice or use instant cloning instead.",
              details: error.message,
            },
            { status: 400 },
          );
        }

        if (error.message.includes("file")) {
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
      }

      return NextResponse.json(
        {
          error: "Failed to create voice clone. Credits have been refunded.",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 },
      );
    }
  } catch (error) {
    logger.error("[Voice Clone API] Unexpected error:", error);

    if (error instanceof Error && error.message.includes("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 },
    );
  }
}
