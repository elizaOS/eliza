import { and, desc, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { userVoices, voiceCloningJobs, voiceSamples } from "@/db/schemas/user-voices";
import { logger } from "@/lib/utils/logger";
import { getElevenLabsService } from "./elevenlabs";

/**
 * Service for managing voice cloning operations with ElevenLabs.
 *
 * Voice clone creation lives in `apps/api/v1/voice/clone/route.ts` (Worker
 * route, R2-backed). This service exposes the read/update/delete helpers
 * shared by the rest of the voice routes.
 */
export class VoiceCloningService {
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
      .where(and(eq(userVoices.id, voiceId), eq(userVoices.organizationId, organizationId)));

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
      .where(and(eq(userVoices.id, voiceId), eq(userVoices.organizationId, organizationId)))
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
    const [voice] = await dbRead.select().from(userVoices).where(eq(userVoices.id, voiceId));

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
        and(eq(voiceCloningJobs.id, jobId), eq(voiceCloningJobs.organizationId, organizationId)),
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
}

// Export singleton instance
export const voiceCloningService = new VoiceCloningService();
