/**
 * POST /api/v1/voice/clone — create a voice clone (instant or professional).
 *
 * Workers-native flow. Sample upload happens through R2 (env.BLOB) and the
 * ElevenLabs HTTP API is called directly with `fetch` so the Worker bundle
 * stays free of the SDK's Node-only deps.
 *
 * Credit handling:
 *   1. Reserve credits up-front (prevents overcommitment).
 *   2. Run upload + ElevenLabs call + DB writes.
 *   3. Reconcile reservation on success; refund (`reconcile(0)`) on failure.
 *
 * Request (multipart/form-data):
 *   - name           string (required)
 *   - cloneType      "instant" | "professional" (required)
 *   - description    string (optional)
 *   - settings       JSON string (optional; e.g. {"language":"en"})
 *   - file0,file1... File (1..10, total <= 100MB)
 */

import { Hono } from "hono";
import {
  type NewUserVoice,
  type NewVoiceCloningJob,
  type NewVoiceSample,
  userVoicesRepository,
} from "@/db/repositories/user-voices";
import { failureResponse, jsonError, ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { billFlatUsage } from "@/lib/services/ai-billing";
import { calculateVoiceCloneCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const MAX_FILES = 10;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB combined
const ELEVENLABS_API = "https://api.elevenlabs.io";
const DEFAULT_R2_PUBLIC_HOST = "blob.elizacloud.ai";

type CloneType = "instant" | "professional";

function isUploadedFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "size" in value &&
    "type" in value &&
    "arrayBuffer" in value
  );
}

interface ElevenLabsAddVoiceResponse {
  voice_id: string;
  requires_verification?: boolean;
}

interface ElevenLabsErrorBody {
  detail?:
    | { status?: string; message?: string }
    | { status?: string; message?: string }[]
    | string
    | undefined;
}

const app = new Hono<AppEnv>();

// Voice cloning is expensive (per-clone cost + ElevenLabs slot consumption).
// STRICT preset = 10 requests/min per identity.
app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  let reservation: CreditReservation | undefined;
  let jobId: string | undefined;
  let cloneType: CloneType | undefined;
  let cloneCost: Awaited<ReturnType<typeof calculateVoiceCloneCostFromCatalog>> | undefined;
  let user: { id: string; organization_id: string } | undefined;
  let apiKeyId: string | null = null;
  let totalSize = 0;
  let fileCount = 0;
  let voiceName = "";

  // Track partial state so the catch branch can clean up R2 + DB orphans
  // when the clone fails before we've successfully persisted a `user_voices`
  // row. Once `userVoicePersisted` flips, the voice clone is committed and
  // the cleanup branch must NOT delete those samples or R2 objects.
  const uploadedR2Keys: string[] = [];
  let userVoicePersisted = false;

  try {
    const auth = await requireUserOrApiKeyWithOrg(c);
    user = { id: auth.id, organization_id: auth.organization_id };
    apiKeyId = await getRequestApiKeyId(c);

    const apiKey = c.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      logger.error("[Voice Clone API] ELEVENLABS_API_KEY not configured");
      return jsonError(c, 500, "Voice cloning is not configured", "internal_error");
    }

    const formData = await c.req.formData();

    const nameField = formData.get("name");
    if (typeof nameField !== "string" || nameField.length === 0) {
      throw ValidationError("Missing required field: name");
    }
    voiceName = nameField;

    const cloneTypeField = formData.get("cloneType");
    if (cloneTypeField !== "instant" && cloneTypeField !== "professional") {
      throw ValidationError("Invalid cloneType. Must be 'instant' or 'professional'");
    }
    cloneType = cloneTypeField;

    const descriptionField = formData.get("description");
    const description =
      typeof descriptionField === "string" && descriptionField.length > 0
        ? descriptionField
        : undefined;

    const settingsField = formData.get("settings");
    let settings: Record<string, unknown> = {};
    if (typeof settingsField === "string" && settingsField.length > 0) {
      try {
        const parsed: unknown = JSON.parse(settingsField);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          settings = parsed as Record<string, unknown>;
        } else {
          throw ValidationError("settings must be a JSON object");
        }
      } catch {
        throw ValidationError("Invalid settings JSON");
      }
    }

    const files: File[] = [];
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("file")) continue;
      if (!isUploadedFile(value)) continue;
      files.push(value);
    }

    if (files.length === 0) {
      throw ValidationError("At least one audio file is required");
    }
    if (files.length > MAX_FILES) {
      throw ValidationError(`Maximum ${MAX_FILES} files allowed`);
    }

    for (const file of files) {
      if (file.size === 0) {
        throw ValidationError(`File "${file.name}" is empty`);
      }
      if (file.size > MAX_FILE_SIZE) {
        throw ValidationError(
          `File "${file.name}" exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        );
      }
      const isAudio =
        file.type.startsWith("audio/") || file.type === "" || file.type.startsWith("video/mp4");
      if (!isAudio) {
        throw ValidationError(
          `File "${file.name}" has invalid type "${file.type}". Only audio files are allowed.`,
        );
      }
      totalSize += file.size;
    }
    if (totalSize > MAX_TOTAL_SIZE) {
      throw ValidationError(`Total file size exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB limit`);
    }
    fileCount = files.length;

    logger.info(`[Voice Clone API] Creating ${cloneType} voice clone: ${voiceName}`, {
      userId: user.id,
      organizationId: user.organization_id,
      fileCount,
      totalSize,
    });

    cloneCost = await calculateVoiceCloneCostFromCatalog({ cloneType });

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        amount: cloneCost.totalCost,
        userId: user.id,
        description: `Voice cloning (${cloneType}): ${voiceName}`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return c.json(
          {
            success: false,
            error: "Insufficient balance",
            code: "insufficient_credits" as const,
            details: { required: error.required, cloneType },
          },
          402,
        );
      }
      throw error;
    }

    const newJob: NewVoiceCloningJob = {
      organizationId: user.organization_id,
      userId: user.id,
      jobType: cloneType,
      voiceName,
      voiceDescription: description,
      status: "processing",
      metadata: { fileCount, totalSize },
      startedAt: new Date(),
    };
    const createdJob = await userVoicesRepository.createCloningJob(newJob);
    jobId = createdJob.id;

    // 1) Upload samples to R2 in parallel. Persisted alongside the DB row so
    //    we have a backup independent of ElevenLabs. Failure here aborts the
    //    clone (same behaviour as the legacy service when a token was set).
    const r2Host = c.env.R2_PUBLIC_HOST || DEFAULT_R2_PUBLIC_HOST;
    const sampleRecords = await Promise.all(
      files.map(async (file) => {
        const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "sample";
        const key = `voice-samples/${user!.organization_id}/${createdJob.id}/${crypto.randomUUID()}-${safeName}`;
        const body = await file.arrayBuffer();
        await c.env.BLOB.put(key, body, {
          httpMetadata: { contentType: file.type || "application/octet-stream" },
          customMetadata: {
            userId: user!.id,
            organizationId: user!.organization_id,
            jobId: createdJob.id,
            originalName: file.name,
          },
        });
        uploadedR2Keys.push(key);
        const url = `https://${r2Host}/${key}`;
        return {
          file,
          record: {
            jobId: createdJob.id,
            organizationId: user!.organization_id,
            userId: user!.id,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type || "application/octet-stream",
            blobUrl: url,
          } satisfies NewVoiceSample,
        };
      }),
    );

    if (sampleRecords.length > 0) {
      await userVoicesRepository.createSamples(sampleRecords.map((s) => s.record));
    }

    // 2) Call ElevenLabs.
    const language = typeof settings.language === "string" ? settings.language : "en";
    const elevenlabsVoiceId = await createElevenLabsVoice({
      apiKey,
      cloneType,
      name: voiceName,
      description,
      language,
      files,
    });

    // 3) Persist user_voices row.
    const newUserVoice: NewUserVoice = {
      organizationId: user.organization_id,
      userId: user.id,
      elevenlabsVoiceId,
      name: voiceName,
      description,
      cloneType,
      settings,
      sampleCount: fileCount,
      creationCost: String(cloneCost.totalCost),
    };
    const insertedVoice = await userVoicesRepository.createVoice(newUserVoice);
    userVoicePersisted = true;

    // Backfill the sample rows with the new userVoiceId.
    await userVoicesRepository.attachSamplesToVoice(createdJob.id, insertedVoice.id);

    const startTime = createdJob.startedAt?.getTime() ?? Date.now();
    const duration = Date.now() - startTime;

    const updatedJob = await userVoicesRepository.completeCloningJob({
      jobId: createdJob.id,
      userVoiceId: insertedVoice.id,
      elevenlabsVoiceId,
    });

    const billing = await billFlatUsage(
      {
        organizationId: user.organization_id,
        userId: user.id,
        apiKeyId,
        model: `elevenlabs/${cloneType}`,
        provider: "elevenlabs",
        billingSource: "elevenlabs",
        description: `Voice cloning (${cloneType}): ${voiceName}`,
      },
      cloneCost,
      reservation,
    );

    c.executionCtx.waitUntil(
      usageService
        .create({
          organization_id: user.organization_id,
          user_id: user.id,
          api_key_id: apiKeyId,
          type: "voice_cloning",
          model: cloneType,
          provider: "elevenlabs",
          input_tokens: 0,
          output_tokens: 0,
          input_cost: String(billing.totalCost),
          output_cost: String(0),
          markup: String(billing.platformMarkup),
          is_successful: true,
          duration_ms: duration,
          metadata: {
            voiceName,
            fileCount,
            totalSize,
            baseTotalCost: billing.baseTotalCost,
            billingSource: "elevenlabs",
          },
        })
        .catch((error) => {
          logger.error("[Voice Clone API] Failed to create usage record", {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );

    logger.info("[Voice Clone API] Voice clone created", {
      userVoiceId: insertedVoice.id,
      jobId: updatedJob.id,
      duration,
    });

    return c.json(
      {
        success: true as const,
        voice: {
          id: insertedVoice.id,
          elevenlabsVoiceId: insertedVoice.elevenlabsVoiceId,
          name: insertedVoice.name,
          description: insertedVoice.description,
          cloneType: insertedVoice.cloneType,
          status: updatedJob.status,
          sampleCount: insertedVoice.sampleCount,
          createdAt: insertedVoice.createdAt.toISOString(),
        },
        job: {
          id: updatedJob.id,
          status: updatedJob.status,
          progress: updatedJob.progress,
        },
        creditsDeducted: cloneCost.totalCost,
        estimatedCompletionTime: cloneType === "professional" ? "30-60 minutes" : "30 seconds",
      },
      201,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Cleanup pass — runs only when we have partial state to undo (i.e.
    // the user_voices row was never written). Once that row is committed,
    // the voice clone is real and we must not delete its samples or R2
    // objects, even if a later step (billing, usage tracking) throws.
    // Each cleanup operation is wrapped in its own try/catch so a cleanup
    // failure does not mask the original error from the client.
    if (jobId) {
      if (!userVoicePersisted) {
        // 1) Drop the voice_samples rows we wrote for this job (orphaned
        //    rows referencing R2 keys we're about to delete).
        try {
          await userVoicesRepository.deleteSamplesByJobId(jobId);
        } catch (dbError) {
          logger.error("[Voice Clone API] Failed to delete orphan voice_samples rows", {
            jobId,
            error: dbError instanceof Error ? dbError.message : String(dbError),
          });
        }

        // 2) Delete the orphaned R2 objects we uploaded before the failure.
        for (const key of uploadedR2Keys) {
          try {
            await c.env.BLOB.delete(key);
          } catch (blobError) {
            logger.error("[Voice Clone API] Failed to delete orphan R2 object", {
              jobId,
              key,
              error: blobError instanceof Error ? blobError.message : String(blobError),
            });
          }
        }
      }

      // 3) Mark the job failed last so it carries the canonical error
      //    message even if step 1 or 2 emitted their own log lines.
      try {
        await userVoicesRepository.markCloningJobFailed(jobId, errorMessage);
      } catch (dbError) {
        logger.error("[Voice Clone API] Failed to mark job failed", {
          jobId,
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
      }
    }

    if (reservation) {
      await reservation.reconcile(0);
      logger.info("[Voice Clone API] Credits refunded", {
        organizationId: user?.organization_id,
        amount: cloneCost?.totalCost,
      });
    }

    if (user && cloneType) {
      const failedUser = user;
      const failedCloneType = cloneType;
      c.executionCtx.waitUntil(
        usageService
          .create({
            organization_id: failedUser.organization_id,
            user_id: failedUser.id,
            api_key_id: apiKeyId,
            type: "voice_cloning",
            model: failedCloneType,
            provider: "elevenlabs",
            input_tokens: 0,
            output_tokens: 0,
            input_cost: String(0),
            output_cost: String(0),
            is_successful: false,
            error_message: errorMessage,
          })
          .catch((usageError) => {
            logger.error("[Voice Clone API] Failed to record failed usage", {
              error: usageError instanceof Error ? usageError.message : String(usageError),
            });
          }),
      );
    }

    if (error instanceof Error) {
      const lower = errorMessage.toLowerCase();
      if (lower.includes("rate limit")) {
        return jsonError(c, 429, "Rate limit exceeded. Please try again later.");
      }
      if (lower.includes("quota")) {
        return c.json(
          {
            success: false,
            error:
              "Voice cloning service is temporarily unavailable due to high demand. Please try again shortly.",
            code: "internal_error" as const,
            type: "service_unavailable",
            retryAfter: "1 hour",
          },
          503,
        );
      }
      if (lower.includes("professional_voice_limit_reached")) {
        return jsonError(
          c,
          400,
          "Professional voice limit reached. Delete an existing professional voice or use instant cloning instead.",
        );
      }
    }

    if (error instanceof Error && (error as { status?: number }).status) {
      return failureResponse(c, error);
    }

    logger.error("[Voice Clone API] Unhandled error", {
      error: errorMessage,
      jobId,
    });
    return c.json(
      {
        success: false,
        error: "Failed to create voice clone. Credits have been refunded.",
        code: "internal_error" as const,
        details: errorMessage,
      },
      500,
    );
  }
});

export default app;

// ---------------------------------------------------------------------------

/**
 * Same lookup as `messages/route.ts` — the auth shim doesn't surface the API
 * key row, so we re-derive it from headers. Returns null for session auth.
 */
async function getRequestApiKeyId(c: AppContext): Promise<string | null> {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const auth = c.req.header("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const elizaBearer = bearer && bearer.startsWith("eliza_") ? bearer : null;
  const apiKey = apiKeyHeader || elizaBearer;
  if (!apiKey) return null;
  const { apiKeysService } = await import("@/lib/services/api-keys");
  const validated = await apiKeysService.validateApiKey(apiKey);
  return validated ? validated.id : null;
}

/**
 * Direct ElevenLabs HTTP calls — avoids the SDK so the Worker bundle doesn't
 * need its Node-specific deps (form-data, fs, etc.).
 *
 * Instant cloning: single `POST /v1/voices/add` (multipart).
 * Professional cloning: `POST /v1/voices/pvc` (JSON, metadata only) followed
 * by `POST /v1/voices/pvc/{voice_id}/samples` (multipart) per file batch,
 * then `POST /v1/voices/pvc/{voice_id}/train` to kick off training. Without
 * the train call PVC voices stay in "ready to train" forever.
 */
async function createElevenLabsVoice(params: {
  apiKey: string;
  cloneType: CloneType;
  name: string;
  description: string | undefined;
  language: string;
  files: File[];
}): Promise<string> {
  const { apiKey, cloneType, name, description, language, files } = params;

  if (cloneType === "instant") {
    const fd = new FormData();
    fd.append("name", name);
    if (description) fd.append("description", description);
    for (const file of files) {
      fd.append("files", file, file.name);
    }
    const res = await fetch(`${ELEVENLABS_API}/v1/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: fd,
    });
    return parseElevenLabsResponse(res, "instant");
  }

  // Professional voice cloning is a 3-step operation in ElevenLabs.
  const createRes = await fetch(`${ELEVENLABS_API}/v1/voices/pvc`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, description, language }),
  });
  const voiceId = await parseElevenLabsResponse(createRes, "professional");

  const uploadFd = new FormData();
  for (const file of files) {
    uploadFd.append("files", file, file.name);
  }
  const uploadRes = await fetch(
    `${ELEVENLABS_API}/v1/voices/pvc/${encodeURIComponent(voiceId)}/samples`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: uploadFd,
    },
  );
  if (!uploadRes.ok) {
    const message = await readElevenLabsError(uploadRes);
    throw new Error(`ElevenLabs PVC sample upload failed: ${message}`);
  }

  const trainRes = await fetch(
    `${ELEVENLABS_API}/v1/voices/pvc/${encodeURIComponent(voiceId)}/train`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ language }),
    },
  );
  if (!trainRes.ok) {
    const message = await readElevenLabsError(trainRes);
    throw new Error(`ElevenLabs PVC train failed: ${message}`);
  }

  return voiceId;
}

async function parseElevenLabsResponse(res: Response, cloneType: CloneType): Promise<string> {
  if (!res.ok) {
    const message = await readElevenLabsError(res);
    if (cloneType === "professional" && /limit|quota/i.test(message)) {
      throw new Error("professional_voice_limit_reached");
    }
    throw new Error(`ElevenLabs error: ${message}`);
  }
  const body = (await res.json()) as ElevenLabsAddVoiceResponse;
  if (!body.voice_id) {
    throw new Error("ElevenLabs response missing voice_id");
  }
  return body.voice_id;
}

async function readElevenLabsError(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `${res.status} ${res.statusText}`;
  try {
    const parsed = JSON.parse(text) as ElevenLabsErrorBody;
    if (parsed.detail) {
      if (typeof parsed.detail === "string") return parsed.detail;
      if (Array.isArray(parsed.detail)) {
        return parsed.detail.map((d) => d.message ?? d.status ?? "").join("; ");
      }
      return parsed.detail.message ?? parsed.detail.status ?? text;
    }
    return text;
  } catch {
    return text;
  }
}
