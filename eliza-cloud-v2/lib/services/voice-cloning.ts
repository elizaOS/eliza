import { dbRead, dbWrite } from "@/db/client";
import {
  userVoices,
  voiceCloningJobs,
  voiceSamples,
} from "@/db/schemas/user-voices";
import type {
  NewUserVoice,
  NewVoiceCloningJob,
} from "@/db/schemas/user-voices";
import { eq, and, desc } from "drizzle-orm";
import { getElevenLabsService } from "./elevenlabs";
import { logger } from "@/lib/utils/logger";
import { put } from "@vercel/blob";
import {
  VOICE_CLONE_INSTANT_COST,
  VOICE_CLONE_PROFESSIONAL_COST,
} from "@/lib/pricing-constants";

/**
 * Parameters for creating a voice clone.
 */
export interface CreateVoiceCloneParams {
  organizationId: string;
  userId: string;
  name: string;
  description?: string;
  cloneType: "instant" | "professional";
  files: File[];
  settings?: Record<string, unknown>;
}

/**
 * Result of creating a voice clone.
 */
export interface VoiceCloneResult {
  userVoice: NewUserVoice;
  job: NewVoiceCloningJob;
}

/**
 * Service for managing voice cloning operations with ElevenLabs.
 */
export class VoiceCloningService {
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  private readonly ALLOWED_TYPES = [
    "audio/mpeg",
    "audio/wav",
    "audio/mp3",
    "audio/x-wav",
    "audio/webm",
    "audio/webm;codecs=opus",
    "audio/ogg",
    "audio/m4a",
    "audio/x-m4a",
    "audio/mp4",
  ];
  private readonly MIN_DURATION_INSTANT = 60; // 1 minute
  private readonly MIN_DURATION_PROFESSIONAL = 1800; // 30 minutes

  /**
   * Create a voice clone (instant or professional)
   */
  async createVoiceClone(
    params: CreateVoiceCloneParams,
  ): Promise<VoiceCloneResult> {
    const {
      organizationId,
      userId,
      name,
      description,
      cloneType,
      files,
      settings = {},
    } = params;

    logger.info(`[VoiceCloning] Starting ${cloneType} voice clone: ${name}`, {
      organizationId,
      userId,
      fileCount: files.length,
    });

    let job: NewVoiceCloningJob | undefined;

    try {
      // Validate files
      this.validateAudioFiles(files);

      // Create job record
      const [createdJob] = await dbWrite
        .insert(voiceCloningJobs)
        .values({
          organizationId,
          userId,
          jobType: cloneType,
          voiceName: name,
          voiceDescription: description,
          status: "processing",
          metadata: {
            fileCount: files.length,
            totalSize: files.reduce((sum, f) => sum + f.size, 0),
          },
          startedAt: new Date(),
        })
        .returning();
      job = createdJob;

      logger.info(`[VoiceCloning] Created job ${job.id}`, { jobId: job.id });

      // Upload files to Vercel Blob for backup/reference (optional - skip if no token)
      const hasVercelToken = !!process.env.BLOB_READ_WRITE_TOKEN;

      if (hasVercelToken) {
        await Promise.all(
          files.map(async (file) => {
            // Upload to Vercel Blob
            const blob = await put(
              `voice-samples/${organizationId}/${job.id}/${file.name}`,
              file,
              {
                access: "public",
                addRandomSuffix: true,
              },
            );

            logger.info("[VoiceCloning] Uploaded sample to blob storage", {
              jobId: job.id,
              fileName: file.name,
              blobUrl: blob.url,
            });

            // Store sample metadata in database
            await dbWrite.insert(voiceSamples).values({
              jobId: job.id,
              organizationId,
              userId,
              fileName: file.name,
              fileSize: file.size,
              fileType: file.type,
              blobUrl: blob.url,
            });
          }),
        );
      } else {
        logger.info(
          "[VoiceCloning] Skipping blob storage (no token configured)",
          {
            jobId: job.id,
          },
        );
      }

      logger.info("[VoiceCloning] Creating voice in ElevenLabs", {
        jobId: job.id,
      });

      // Create voice clone in ElevenLabs (use original files)
      const elevenlabs = getElevenLabsService();

      // Extract language from settings if provided, otherwise default to 'en'
      const language = (settings.language as string) || "en";

      const result =
        cloneType === "instant"
          ? await elevenlabs.createInstantVoiceClone({
              name,
              description,
              language,
              files,
            })
          : await elevenlabs.createProfessionalVoiceClone({
              name,
              description,
              language,
              files,
            });

      logger.info("[VoiceCloning] Voice created in ElevenLabs", {
        jobId: job.id,
        elevenlabsVoiceId: result.voiceId,
      });

      // Determine creation cost using constants for consistency
      const creationCost =
        cloneType === "instant"
          ? VOICE_CLONE_INSTANT_COST
          : VOICE_CLONE_PROFESSIONAL_COST;

      // Create user_voices record
      const [userVoice] = await dbWrite
        .insert(userVoices)
        .values({
          organizationId,
          userId,
          elevenlabsVoiceId: result.voiceId,
          name,
          description,
          cloneType,
          settings,
          sampleCount: files.length,
          creationCost: String(creationCost),
        })
        .returning();

      logger.info("[VoiceCloning] User voice record created", {
        jobId: job.id,
        userVoiceId: userVoice.id,
      });

      // Update job as completed
      const [updatedJob] = await dbWrite
        .update(voiceCloningJobs)
        .set({
          status: "completed",
          userVoiceId: userVoice.id,
          elevenlabsVoiceId: result.voiceId,
          progress: 100,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(voiceCloningJobs.id, job.id))
        .returning();

      logger.info("[VoiceCloning] Voice cloning completed successfully", {
        jobId: job.id,
        userVoiceId: userVoice.id,
        elevenlabsVoiceId: result.voiceId,
      });

      return { userVoice, job: updatedJob };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Only update job status if job was created
      if (job) {
        logger.error("[VoiceCloning] Error creating voice clone", {
          jobId: job.id,
          error: errorMessage,
        });

        // Update job as failed
        await dbWrite
          .update(voiceCloningJobs)
          .set({
            status: "failed",
            errorMessage,
            updatedAt: new Date(),
          })
          .where(eq(voiceCloningJobs.id, job.id));
      } else {
        logger.error(
          "[VoiceCloning] Error creating voice clone (before job creation)",
          {
            error: errorMessage,
          },
        );
      }

      throw error;
    }
  }

  /**
   * Get user's voices
   */
  async getUserVoices(params: {
    organizationId: string;
    userId?: string;
    includeInactive?: boolean;
    cloneType?: "instant" | "professional";
  }) {
    const conditions = [eq(userVoices.organizationId, params.organizationId)];

    if (params.userId) {
      conditions.push(eq(userVoices.userId, params.userId));
    }

    if (!params.includeInactive) {
      conditions.push(eq(userVoices.isActive, true));
    }

    if (params.cloneType) {
      conditions.push(eq(userVoices.cloneType, params.cloneType));
    }

    return dbRead
      .select()
      .from(userVoices)
      .where(and(...conditions))
      .orderBy(desc(userVoices.createdAt));
  }

  /**
   * Get voice by ID
   */
  async getVoiceById(voiceId: string, organizationId: string) {
    const [voice] = await dbRead
      .select()
      .from(userVoices)
      .where(
        and(
          eq(userVoices.id, voiceId),
          eq(userVoices.organizationId, organizationId),
        ),
      );

    if (!voice) {
      return null;
    }

    // Get associated samples
    const samples = await dbRead
      .select()
      .from(voiceSamples)
      .where(eq(voiceSamples.userVoiceId, voiceId));

    return { ...voice, samples };
  }

  /**
   * Update voice metadata
   */
  async updateVoice(
    voiceId: string,
    organizationId: string,
    updates: {
      name?: string;
      description?: string;
      settings?: Record<string, unknown>;
      isActive?: boolean;
      isPublic?: boolean;
    },
  ) {
    const [updatedVoice] = await dbWrite
      .update(userVoices)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userVoices.id, voiceId),
          eq(userVoices.organizationId, organizationId),
        ),
      )
      .returning();

    if (!updatedVoice) {
      throw new Error("Voice not found");
    }

    // If name or settings changed, update in ElevenLabs
    if (updates.name || updates.settings) {
      const elevenlabs = getElevenLabsService();
      await elevenlabs.updateVoiceSettings(updatedVoice.elevenlabsVoiceId, {
        name: updates.name,
        ...(updates.settings as Record<string, unknown>),
      });
    }

    return updatedVoice;
  }

  /**
   * Delete voice
   */
  async deleteVoice(voiceId: string, organizationId: string): Promise<void> {
    // Get voice record
    const voice = await this.getVoiceById(voiceId, organizationId);
    if (!voice) {
      throw new Error("Voice not found");
    }

    logger.info("[VoiceCloning] Deleting voice", {
      voiceId,
      elevenlabsVoiceId: voice.elevenlabsVoiceId,
    });

    // Delete from ElevenLabs
    const elevenlabs = getElevenLabsService();
    await elevenlabs.deleteVoice(voice.elevenlabsVoiceId);
    logger.info("[VoiceCloning] Voice deleted from ElevenLabs", {
      elevenlabsVoiceId: voice.elevenlabsVoiceId,
    });

    // Soft delete from database (set inactive instead of hard delete)
    await dbWrite
      .update(userVoices)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(userVoices.id, voiceId));

    logger.info("[VoiceCloning] Voice marked as inactive", { voiceId });
  }

  /**
   * Increment usage count for a voice
   */
  async incrementUsageCount(voiceId: string): Promise<void> {
    // Get current voice
    const [voice] = await dbRead
      .select()
      .from(userVoices)
      .where(eq(userVoices.id, voiceId));

    if (voice) {
      await dbWrite
        .update(userVoices)
        .set({
          usageCount: voice.usageCount + 1,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(userVoices.id, voiceId));
    }
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string, organizationId: string) {
    const [job] = await dbRead
      .select()
      .from(voiceCloningJobs)
      .where(
        and(
          eq(voiceCloningJobs.id, jobId),
          eq(voiceCloningJobs.organizationId, organizationId),
        ),
      );

    return job || null;
  }

  /**
   * Get user's jobs
   */
  async getUserJobs(organizationId: string, userId?: string) {
    const conditions = [eq(voiceCloningJobs.organizationId, organizationId)];

    if (userId) {
      conditions.push(eq(voiceCloningJobs.userId, userId));
    }

    return dbRead
      .select()
      .from(voiceCloningJobs)
      .where(and(...conditions))
      .orderBy(desc(voiceCloningJobs.createdAt));
  }

  /**
   * Validate audio files
   */
  private validateAudioFiles(files: File[]): void {
    if (!files || files.length === 0) {
      throw new Error("At least one audio file is required");
    }

    for (const file of files) {
      // Check file size
      if (file.size > this.MAX_FILE_SIZE) {
        throw new Error(
          `File "${file.name}" exceeds maximum size of ${this.MAX_FILE_SIZE / 1024 / 1024}MB`,
        );
      }

      // Check file type - allow any audio/* or specific types
      const isValidType =
        file.type.startsWith("audio/") ||
        this.ALLOWED_TYPES.some((type) =>
          file.type.includes(type.split(";")[0]),
        );

      if (!isValidType) {
        throw new Error(
          `File "${file.name}" has invalid type "${file.type}". Only audio files are allowed.`,
        );
      }

      // Check file size is not zero
      if (file.size === 0) {
        throw new Error(`File "${file.name}" is empty`);
      }
    }

    // Calculate total size
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    const maxTotalSize = this.MAX_FILE_SIZE * 10; // Max 100MB total

    if (totalSize > maxTotalSize) {
      throw new Error(
        `Total file size exceeds maximum of ${maxTotalSize / 1024 / 1024}MB`,
      );
    }
  }
}

// Export singleton instance
export const voiceCloningService = new VoiceCloningService();
