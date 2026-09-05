/**
 * POST /api/v1/voice/clone — create a voice clone (instant or professional).
 *
 * Workers-native flow. Sample upload happens through R2 (env.BLOB) and the
 * ElevenLabs HTTP API is called directly with `fetch` so the Worker bundle
 * stays free of the SDK's Node-only deps.
 *
 * Credit handling:
 *   1. Admit the priced operation up-front (prevents overcommitment).
 *   2. Run upload + ElevenLabs call + DB writes.
 *   3. Settle on success; release the admission on pre-commit failure.
 *
 * Request (multipart/form-data):
 *   - name           string (required)
 *   - cloneType      "instant" | "professional" (required)
 *   - description    string (optional)
 *   - settings       JSON string (optional; e.g. {"language":"en"})
 *   - file0,file1... File (1..10, total <= 100MB)
 */

import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import {
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import {
  type NewUserVoice,
  type NewVoiceCloningJob,
  type NewVoiceSample,
  userVoicesRepository,
  type VoiceCloneProviderState,
  type VoiceCloneProviderStep,
} from "@/db/repositories/user-voices";
import {
  failureResponse,
  jsonError,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { type BillingContext, billFlatUsage } from "@/lib/services/ai-billing";
import { calculateVoiceCloneCostFromCatalog } from "@/lib/services/ai-pricing";
import { InsufficientCreditsError } from "@/lib/services/credits";
import { deferredCredentialAdmissionGuard } from "@/lib/services/deferred-credential-admission-guard";
import { usageService } from "@/lib/services/usage";
import type { VoiceCloneFailureReason } from "@/lib/services/voice-clone-failure";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const MAX_FILES = 10;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB combined
const ELEVENLABS_API = "https://api.elevenlabs.io";
const DEFAULT_R2_PUBLIC_HOST = "blob.eliza.app";

type CloneType = "instant" | "professional";
type DurableCloneResponse = {
  status: 201 | 402;
  body: Record<string, unknown>;
};

function durableCloneResponse(value: unknown): DurableCloneResponse | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { status?: unknown; body?: unknown };
  if (candidate.status !== 201 && candidate.status !== 402) return null;
  if (!candidate.body || typeof candidate.body !== "object") return null;
  return {
    status: candidate.status,
    body: candidate.body as Record<string, unknown>,
  };
}

class VoiceCloneSubmissionUnknownError extends ElizaError {
  override readonly name = "VoiceCloneSubmissionUnknownError";
  readonly step: VoiceCloneProviderStep;

  constructor(step: VoiceCloneProviderStep, cause: unknown) {
    super(`ElevenLabs ${step} submission outcome is unknown`, {
      code: "VOICE_CLONE_SUBMISSION_UNKNOWN",
      context: { provider: "elevenlabs", step },
      cause,
      severity: "ephemeral",
    });
    this.step = step;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const stableBytes =
    bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer;
  const digest = await crypto.subtle.digest("SHA-256", stableBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function voiceCloneRequestDigest(input: {
  cloneType: CloneType;
  name: string;
  description: string | undefined;
  settings: Record<string, unknown>;
  files: File[];
}): Promise<string> {
  const files = await Promise.all(
    input.files.map(async (file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
      sha256: await sha256Hex(await file.arrayBuffer()),
    })),
  );
  return sha256Hex(
    new TextEncoder().encode(
      canonicalJson({
        cloneType: input.cloneType,
        name: input.name,
        description: input.description ?? null,
        settings: input.settings,
        files,
      }),
    ),
  );
}

function providerAcceptanceIsPossible(
  state: VoiceCloneProviderState | "not_dispatched",
  voiceId: string | undefined,
): boolean {
  return (
    state === "submitted" ||
    state === "submission_unknown" ||
    state === "accepted" ||
    voiceId !== undefined
  );
}

function providerSubmissionIsAmbiguous(
  state: VoiceCloneProviderState | "not_dispatched",
): boolean {
  return state === "submitted" || state === "submission_unknown";
}

function safeVoiceCloneFailureReason(
  state: VoiceCloneProviderState | "not_dispatched",
  providerMayHaveAccepted: boolean,
): VoiceCloneFailureReason {
  if (providerSubmissionIsAmbiguous(state)) {
    return "provider_submission_unknown";
  }
  if (providerMayHaveAccepted) {
    return "provider_work_reconciliation_required";
  }
  if (state === "rejected") {
    return "provider_request_rejected";
  }
  return "voice_clone_request_failed";
}

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
  let admission: Awaited<
    ReturnType<typeof admitFlatGenerativeOperation>
  > | null = null;
  let jobId: string | undefined;
  let cloneType: CloneType | undefined;
  let cloneCost:
    | Awaited<ReturnType<typeof calculateVoiceCloneCostFromCatalog>>
    | undefined;
  let billingContext: BillingContext | undefined;
  let user: { id: string; organization_id: string } | undefined;
  let apiKeyId: string | null = null;
  let totalSize = 0;
  let fileCount = 0;
  let voiceName = "";
  let description: string | undefined;
  let settings: Record<string, unknown> = {};
  let files: File[] = [];
  let idempotencyKey = "";

  // Provider submission is the irreversible boundary. A local `user_voices`
  // insert is only a projection of that external outcome and must never be
  // used to decide whether evidence can be deleted or credits released.
  const uploadedR2Keys: string[] = [];
  let providerState: VoiceCloneProviderState | "not_dispatched" =
    "not_dispatched";
  let providerStep: VoiceCloneProviderStep | undefined;
  let providerVoiceId: string | undefined;

  let caller: Awaited<ReturnType<typeof requireGenerativeRouteCaller>>;
  try {
    const apiKey = c.env.ELEVENLABS_API_KEY;
    let pendingConfigResponse: Response | undefined;
    if (!apiKey) {
      logger.error("[Voice Clone API] ELEVENLABS_API_KEY not configured");
      pendingConfigResponse = jsonError(
        c,
        500,
        "Voice cloning is not configured",
        "internal_error",
      );
    }

    let validationError: unknown;
    try {
      const formData = await c.req.formData();

      const nameField = formData.get("name");
      if (typeof nameField !== "string" || nameField.length === 0) {
        throw ValidationError("Missing required field: name");
      }
      voiceName = nameField;

      const cloneTypeField = formData.get("cloneType");
      if (cloneTypeField !== "instant" && cloneTypeField !== "professional") {
        throw ValidationError(
          "Invalid cloneType. Must be 'instant' or 'professional'",
        );
      }
      cloneType = cloneTypeField;

      const descriptionField = formData.get("description");
      description =
        typeof descriptionField === "string" && descriptionField.length > 0
          ? descriptionField
          : undefined;

      const settingsField = formData.get("settings");
      settings = {};
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

      files = [];
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
          file.type.startsWith("audio/") ||
          file.type === "" ||
          file.type.startsWith("video/mp4");
        if (!isAudio) {
          throw ValidationError(
            `File "${file.name}" has invalid type "${file.type}". Only audio files are allowed.`,
          );
        }
        totalSize += file.size;
      }
      if (totalSize > MAX_TOTAL_SIZE) {
        throw ValidationError(
          `Total file size exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB limit`,
        );
      }
      fileCount = files.length;
    } catch (error) {
      // error-policy:J1 validation is emitted only after the one strong-auth
      // resolver call below, so malformed protected requests cannot bypass it.
      validationError = error;
    }

    caller = await requireGenerativeRouteCaller(c, {
      deferStrongCredentialCheck:
        pendingConfigResponse === undefined && validationError === undefined,
    });
    await using credentialGuard = deferredCredentialAdmissionGuard({
      organizationId: () => caller.user.organization_id,
      credential: () => caller.credential,
    });
    user = caller.user;
    apiKeyId = caller.apiKeyId;
    if (pendingConfigResponse) return pendingConfigResponse;
    if (!apiKey) throw new Error("Voice-clone provider key was not retained");
    if (validationError) throw validationError;
    if (!cloneType || !voiceName || files.length === 0) {
      throw new Error("Validated voice-clone request was not retained");
    }
    idempotencyKey = c.req.header("Idempotency-Key")?.trim() ?? "";
    if (idempotencyKey.length === 0 || idempotencyKey.length > 128) {
      throw ValidationError("A valid Idempotency-Key header is required");
    }

    logger.info(
      `[Voice Clone API] Creating ${cloneType} voice clone: ${voiceName}`,
      {
        userId: user.id,
        organizationId: user.organization_id,
        fileCount,
        totalSize,
      },
    );

    const requestDigest = await voiceCloneRequestDigest({
      cloneType,
      name: voiceName,
      description,
      settings,
      files,
    });
    const newJob = {
      organizationId: user.organization_id,
      userId: user.id,
      jobType: cloneType,
      voiceName,
      voiceDescription: description,
      status: "processing",
      metadata: { fileCount, totalSize },
      startedAt: new Date(),
      idempotencyKey,
      requestDigest,
    } satisfies NewVoiceCloningJob & {
      idempotencyKey: string;
      requestDigest: string;
    };
    const preparedJob =
      await userVoicesRepository.createOrReadCloningJob(newJob);
    const createdJob = preparedJob.job;
    jobId = createdJob.id;
    if (!preparedJob.created) {
      if (createdJob.requestDigest !== requestDigest) {
        return c.json(
          {
            success: false,
            error:
              "Idempotency-Key was already used with a different voice-clone payload",
            code: "idempotency_conflict" as const,
          },
          409,
        );
      }
      if (createdJob.responsePayload) {
        const replay = durableCloneResponse(createdJob.responsePayload);
        if (!replay) {
          throw new ElizaError("Stored voice-clone response is malformed", {
            code: "VOICE_CLONE_IDEMPOTENCY_RESPONSE_INVALID",
            context: { jobId: createdJob.id },
            severity: "fatal",
          });
        }
        return c.json(replay.body, replay.status);
      }
      return c.json(
        {
          success: false,
          error: "Voice clone request is already recorded",
          code: "idempotency_replay" as const,
          job: {
            id: createdJob.id,
            status: createdJob.status,
            progress: createdJob.progress,
          },
          reconciliationRequired:
            createdJob.status === "reconciliation_required",
        },
        202,
      );
    }

    cloneCost = await calculateVoiceCloneCostFromCatalog({ cloneType });
    billingContext = {
      organizationId: user.organization_id,
      userId: user.id,
      apiKeyId,
      model: `elevenlabs/${cloneType}`,
      provider: "elevenlabs",
      billingSource: "elevenlabs",
      requestId: `voice-clone:${crypto.randomUUID()}`,
      affiliateCode: c.req.header("X-Affiliate-Code") ?? null,
      description: `Voice cloning (${cloneType}): ${voiceName}`,
    };

    try {
      admission = await admitFlatGenerativeOperation({
        c,
        context: billingContext,
        apiKeyId,
        cost: cloneCost,
        admissionSnapshot: caller.admissionSnapshot,
        credential: credentialGuard.credentialForAdmission(),
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        const responseBody = {
          success: false,
          error: "Insufficient balance",
          code: "insufficient_credits" as const,
          details: { required: error.required, cloneType },
        };
        await userVoicesRepository.markCloningJobFailed(
          createdJob.id,
          "Insufficient balance",
          new Date(),
          { status: 402, body: responseBody },
        );
        return c.json(responseBody, 402);
      }
      throw error;
    }

    const userId = user.id;
    const organizationId = user.organization_id;

    // 1) Upload samples to R2 in parallel. Persisted alongside the DB row so
    //    we have a backup independent of ElevenLabs. Failure here aborts the
    //    clone, matching the compatibility service behavior when a token was set.
    const r2Host = c.env.R2_PUBLIC_HOST || DEFAULT_R2_PUBLIC_HOST;
    const sampleRecords = await Promise.all(
      files.map(async (file) => {
        const safeName =
          file.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "sample";
        const key = `voice-samples/${organizationId}/${createdJob.id}/${crypto.randomUUID()}-${safeName}`;
        const body = await file.arrayBuffer();
        await c.env.BLOB.put(key, body, {
          httpMetadata: {
            contentType: file.type || "application/octet-stream",
          },
          customMetadata: {
            userId,
            organizationId,
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
            organizationId,
            userId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type || "application/octet-stream",
            blobUrl: url,
          } satisfies NewVoiceSample,
        };
      }),
    );

    if (sampleRecords.length > 0) {
      await userVoicesRepository.createSamples(
        sampleRecords.map((s) => s.record),
      );
    }

    // 2) Call ElevenLabs.
    const language =
      typeof settings.language === "string" ? settings.language : "en";
    const elevenlabsVoiceId = await createElevenLabsVoice({
      apiKey,
      cloneType,
      name: voiceName,
      description,
      language,
      files,
      markProviderDispatched: admission.markProviderDispatched,
      recordProviderReceipt: async (receipt) => {
        const persistReceipt =
          userVoicesRepository.recordCloningJobProviderReceipt({
            jobId: createdJob.id,
            ...receipt,
          });
        if (receipt.state === "submitted") {
          await persistReceipt;
        }
        providerState = receipt.state;
        providerStep = receipt.step;
        if (receipt.elevenlabsVoiceId) {
          providerVoiceId = receipt.elevenlabsVoiceId;
        }
        if (receipt.state !== "submitted") {
          await persistReceipt;
        }
      },
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

    // Backfill the sample rows with the new userVoiceId.
    await userVoicesRepository.attachSamplesToVoice(
      createdJob.id,
      insertedVoice.id,
    );

    const startTime = createdJob.startedAt?.getTime() ?? Date.now();
    const duration = Date.now() - startTime;

    const successPayload = {
      success: true as const,
      voice: {
        id: insertedVoice.id,
        elevenlabsVoiceId: insertedVoice.elevenlabsVoiceId,
        name: insertedVoice.name,
        description: insertedVoice.description,
        cloneType: insertedVoice.cloneType,
        status: "completed",
        sampleCount: insertedVoice.sampleCount,
        createdAt: insertedVoice.createdAt.toISOString(),
      },
      job: { id: createdJob.id, status: "completed", progress: 100 },
      creditsDeducted: cloneCost.totalCost,
      estimatedCompletionTime:
        cloneType === "professional" ? "30-60 minutes" : "30 seconds",
    };
    const updatedJob = await userVoicesRepository.completeCloningJob({
      jobId: createdJob.id,
      userVoiceId: insertedVoice.id,
      elevenlabsVoiceId,
      responsePayload: { status: 201, body: successPayload },
    });

    const completedAdmission = admission;
    const completedCost = cloneCost;
    const completedBillingContext = billingContext;
    await retainVoiceCloneTask(
      c,
      (async () => {
        const billing = await billFlatUsage(
          completedBillingContext,
          completedCost,
          completedAdmission.reservation,
        );
        if (!completedAdmission.reservation) {
          await completedAdmission.settle(billing.totalCost);
        }
        await usageService.create({
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
        });
      })().catch(async (error) => {
        await completedAdmission.settleUnknown().catch((settlementError) => {
          logger.error(
            "[Voice Clone API] Failed to conservatively settle inference admission",
            {
              error:
                settlementError instanceof Error
                  ? settlementError.message
                  : String(settlementError),
            },
          );
        });
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

    return c.json(successPayload, 201);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const admissionError = asGenerativeCacheApiError(error);

    const providerMayHaveAccepted = providerAcceptanceIsPossible(
      providerState,
      providerVoiceId,
    );
    const safeFailureReason = safeVoiceCloneFailureReason(
      providerState,
      providerMayHaveAccepted,
    );

    // Once provider submission may have been accepted, samples and R2 objects
    // are reconciliation evidence. They survive even when the local voice
    // projection or a later professional-clone step fails.
    // Each deletion operation is wrapped in its own try/catch so a deletion
    // failure does not mask the original error from the client.
    if (jobId) {
      if (!providerMayHaveAccepted) {
        // 1) Drop the voice_samples rows we wrote for this job (orphaned
        //    rows referencing R2 keys we're about to delete).
        try {
          await userVoicesRepository.deleteSamplesByJobId(jobId);
        } catch (dbError) {
          logger.error(
            "[Voice Clone API] Failed to delete orphan voice_samples rows",
            {
              jobId,
              error:
                dbError instanceof Error ? dbError.message : String(dbError),
            },
          );
        }

        // 2) Delete the orphaned R2 objects we uploaded before the failure.
        for (const key of uploadedR2Keys) {
          try {
            await c.env.BLOB.delete(key);
          } catch (blobError) {
            logger.error(
              "[Voice Clone API] Failed to delete orphan R2 object",
              {
                jobId,
                key,
                error:
                  blobError instanceof Error
                    ? blobError.message
                    : String(blobError),
              },
            );
          }
        }
      }

      if (!providerMayHaveAccepted) {
        try {
          await userVoicesRepository.markCloningJobFailed(
            jobId,
            safeFailureReason,
          );
        } catch (dbError) {
          logger.error("[Voice Clone API] Failed to mark job failed", {
            jobId,
            error: dbError instanceof Error ? dbError.message : String(dbError),
          });
        }
      } else {
        try {
          await userVoicesRepository.markCloningJobReconciliationRequired(
            jobId,
            safeFailureReason,
          );
        } catch (dbError) {
          // error-policy:J7 failure to enrich reconciliation diagnostics must
          // not release the conservative settlement or erase prior receipts.
          logger.error(
            "[Voice Clone API] Failed to mark reconciliation required",
            {
              jobId,
              providerState,
              providerStep,
              providerVoiceId,
              error:
                dbError instanceof Error ? dbError.message : String(dbError),
            },
          );
        }
      }
    }

    // Ambiguous or accepted submissions remain conservatively billable. Only
    // a definitive pre-dispatch/provider rejection releases the reservation.
    if (admission && providerMayHaveAccepted) {
      await retainVoiceCloneSettlement(c, admission.settleUnknown(), "settle");
    } else if (admission) {
      await retainVoiceCloneSettlement(c, admission.settle(0), "release");
    }
    if (admission && !providerMayHaveAccepted) {
      logger.info("[Voice Clone API] Credits refunded", {
        organizationId: user?.organization_id,
        amount: cloneCost?.totalCost,
      });
    }

    if (user && cloneType) {
      const failedUser = user;
      const failedCloneType = cloneType;
      await retainVoiceCloneTask(
        c,
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
            error_message: safeFailureReason,
          })
          .catch((usageError) => {
            logger.error("[Voice Clone API] Failed to record failed usage", {
              error:
                usageError instanceof Error
                  ? usageError.message
                  : String(usageError),
            });
          }),
      );
    }

    if (admissionError) return failureResponse(c, admissionError);

    if (providerMayHaveAccepted) {
      logger.error("[Voice Clone API] Provider work requires reconciliation", {
        error: errorMessage,
        cause:
          error instanceof Error && error.cause instanceof Error
            ? error.cause.message
            : undefined,
        jobId,
        organizationId: user?.organization_id,
        userId: user?.id,
        cloneType,
        provider: "elevenlabs",
        providerState,
        providerStep,
        providerVoiceId,
      });
    }

    if (error instanceof Error && !providerMayHaveAccepted) {
      const lower = errorMessage.toLowerCase();
      if (lower.includes("rate limit")) {
        return jsonError(
          c,
          429,
          "Rate limit exceeded. Please try again later.",
        );
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
      organizationId: user?.organization_id,
      userId: user?.id,
      cloneType,
      provider: "elevenlabs",
      providerState,
      providerStep,
      providerVoiceId,
      providerMayHaveAccepted,
      safeFailureReason,
    });
    return c.json(
      {
        success: false,
        error: providerMayHaveAccepted
          ? "Voice clone provider work could not be completed. It is retained for reconciliation."
          : "Failed to create voice clone. Credits have been refunded.",
        code: "internal_error" as const,
        details: {
          outcome: safeFailureReason,
          ...(jobId ? { jobId } : {}),
        },
      },
      500,
    );
  }
});

export default app;

// ---------------------------------------------------------------------------

async function retainVoiceCloneSettlement(
  c: AppContext,
  settlement: Promise<unknown>,
  operation: "settle" | "release",
): Promise<void> {
  await retainVoiceCloneTask(
    c,
    settlement.catch((error) => {
      // error-policy:J7 settlement diagnostics must not replace the provider
      // response; the durable reservation sweep remains the recovery boundary.
      logger.error(
        `[Voice Clone API] Failed to ${operation} inference admission`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }),
  );
}

async function retainVoiceCloneTask(
  c: AppContext,
  task: Promise<unknown>,
): Promise<void> {
  const executionCtx = getGenerativeExecutionContext(c);
  if (executionCtx) executionCtx.waitUntil(task);
  else await task;
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
  markProviderDispatched: (() => Promise<void>) | undefined;
  recordProviderReceipt: (receipt: {
    step: VoiceCloneProviderStep;
    state: VoiceCloneProviderState;
    elevenlabsVoiceId?: string;
    errorMessage?: string;
  }) => Promise<void>;
}): Promise<string> {
  const {
    apiKey,
    cloneType,
    name,
    description,
    language,
    files,
    markProviderDispatched,
    recordProviderReceipt,
  } = params;

  if (cloneType === "instant") {
    const fd = new FormData();
    fd.append("name", name);
    if (description) fd.append("description", description);
    for (const file of files) {
      fd.append("files", file, file.name);
    }
    await markProviderDispatched?.();
    await recordProviderReceipt({ step: "create", state: "submitted" });
    let res: Response;
    try {
      res = await fetch(`${ELEVENLABS_API}/v1/voices/add`, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: fd,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      // error-policy:J2 preserve the transport failure as the cause after
      // durably recording that provider acceptance is unknown.
      await recordProviderReceipt({
        step: "create",
        state: "submission_unknown",
        errorMessage: "provider_transport_uncertain",
      });
      throw new VoiceCloneSubmissionUnknownError("create", error);
    }
    if (!res.ok) {
      await recordProviderReceipt({ step: "create", state: "rejected" });
    }
    const voiceId = await parseElevenLabsResponse(res, "instant");
    await recordProviderReceipt({
      step: "create",
      state: "accepted",
      elevenlabsVoiceId: voiceId,
    });
    return voiceId;
  }

  // Professional voice cloning is a 3-step operation in ElevenLabs.
  await markProviderDispatched?.();
  await recordProviderReceipt({ step: "create", state: "submitted" });
  let createRes: Response;
  try {
    createRes = await fetch(`${ELEVENLABS_API}/v1/voices/pvc`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, description, language }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // error-policy:J2 preserve the transport failure as the cause after
    // durably recording that provider acceptance is unknown.
    await recordProviderReceipt({
      step: "create",
      state: "submission_unknown",
      errorMessage: "provider_transport_uncertain",
    });
    throw new VoiceCloneSubmissionUnknownError("create", error);
  }
  if (!createRes.ok) {
    await recordProviderReceipt({ step: "create", state: "rejected" });
  }
  const voiceId = await parseElevenLabsResponse(createRes, "professional");
  await recordProviderReceipt({
    step: "create",
    state: "accepted",
    elevenlabsVoiceId: voiceId,
  });

  const uploadFd = new FormData();
  for (const file of files) {
    uploadFd.append("files", file, file.name);
  }
  await recordProviderReceipt({
    step: "samples",
    state: "submitted",
    elevenlabsVoiceId: voiceId,
  });
  let uploadRes: Response;
  try {
    uploadRes = await fetch(
      `${ELEVENLABS_API}/v1/voices/pvc/${encodeURIComponent(voiceId)}/samples`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: uploadFd,
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    // error-policy:J2 preserve the transport failure as the cause after
    // durably recording that provider acceptance is unknown.
    await recordProviderReceipt({
      step: "samples",
      state: "submission_unknown",
      elevenlabsVoiceId: voiceId,
      errorMessage: "provider_transport_uncertain",
    });
    throw new VoiceCloneSubmissionUnknownError("samples", error);
  }
  if (!uploadRes.ok) {
    await recordProviderReceipt({
      step: "samples",
      state: "rejected",
      elevenlabsVoiceId: voiceId,
    });
    const message = await readElevenLabsError(uploadRes);
    throw new Error(`ElevenLabs PVC sample upload failed: ${message}`);
  }
  await recordProviderReceipt({
    step: "samples",
    state: "accepted",
    elevenlabsVoiceId: voiceId,
  });

  await recordProviderReceipt({
    step: "train",
    state: "submitted",
    elevenlabsVoiceId: voiceId,
  });
  let trainRes: Response;
  try {
    trainRes = await fetch(
      `${ELEVENLABS_API}/v1/voices/pvc/${encodeURIComponent(voiceId)}/train`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ language }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    // error-policy:J2 preserve the transport failure as the cause after
    // durably recording that provider acceptance is unknown.
    await recordProviderReceipt({
      step: "train",
      state: "submission_unknown",
      elevenlabsVoiceId: voiceId,
      errorMessage: "provider_transport_uncertain",
    });
    throw new VoiceCloneSubmissionUnknownError("train", error);
  }
  if (!trainRes.ok) {
    await recordProviderReceipt({
      step: "train",
      state: "rejected",
      elevenlabsVoiceId: voiceId,
    });
    const message = await readElevenLabsError(trainRes);
    throw new Error(`ElevenLabs PVC train failed: ${message}`);
  }
  await recordProviderReceipt({
    step: "train",
    state: "accepted",
    elevenlabsVoiceId: voiceId,
  });

  return voiceId;
}

async function parseElevenLabsResponse(
  res: Response,
  cloneType: CloneType,
): Promise<string> {
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
