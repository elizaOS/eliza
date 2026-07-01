import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewUserVoice,
  type NewVoiceCloningJob,
  type NewVoiceSample,
  type UserVoice,
  userVoices,
  type VoiceCloningJob,
  type VoiceSample,
  voiceCloningJobs,
  voiceSamples,
} from "../schemas/user-voices";

export type {
  NewUserVoice,
  NewVoiceCloningJob,
  NewVoiceSample,
  UserVoice,
  VoiceCloningJob,
  VoiceSample,
};

export interface ListUserVoicesOptions {
  includeInactive?: boolean;
  cloneType?: "instant" | "professional";
  limit?: number;
  offset?: number;
}

export interface UserVoiceListResult {
  voices: UserVoice[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export class UserVoicesRepository {
  async findByElevenLabsVoiceId(
    elevenlabsVoiceId: string,
  ): Promise<Pick<UserVoice, "id" | "name" | "organizationId"> | undefined> {
    const [voice] = await dbRead
      .select({
        id: userVoices.id,
        name: userVoices.name,
        organizationId: userVoices.organizationId,
      })
      .from(userVoices)
      .where(eq(userVoices.elevenlabsVoiceId, elevenlabsVoiceId))
      .limit(1);

    return voice;
  }

  async listByOrganization(
    organizationId: string,
    options: ListUserVoicesOptions = {},
  ): Promise<UserVoiceListResult> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions: SQL[] = [eq(userVoices.organizationId, organizationId)];
    if (!options.includeInactive) {
      conditions.push(eq(userVoices.isActive, true));
    }
    if (options.cloneType) {
      conditions.push(eq(userVoices.cloneType, options.cloneType));
    }

    const rows = await dbRead
      .select()
      .from(userVoices)
      .where(and(...conditions))
      .orderBy(desc(userVoices.createdAt));

    const voices = rows.slice(offset, offset + limit);

    return {
      voices,
      total: rows.length,
      limit,
      offset,
      hasMore: offset + limit < rows.length,
    };
  }

  async createCloningJob(data: NewVoiceCloningJob): Promise<VoiceCloningJob> {
    const [job] = await dbWrite.insert(voiceCloningJobs).values(data).returning();
    if (!job) throw new Error("Failed to create voice cloning job");
    return job;
  }

  async createSamples(data: NewVoiceSample[]): Promise<void> {
    if (data.length === 0) return;
    await dbWrite.insert(voiceSamples).values(data);
  }

  async createVoice(data: NewUserVoice): Promise<UserVoice> {
    const [voice] = await dbWrite.insert(userVoices).values(data).returning();
    if (!voice) throw new Error("Failed to insert user_voices row");
    return voice;
  }

  async attachSamplesToVoice(jobId: string, userVoiceId: string): Promise<void> {
    await dbWrite.update(voiceSamples).set({ userVoiceId }).where(eq(voiceSamples.jobId, jobId));
  }

  async completeCloningJob(input: {
    jobId: string;
    userVoiceId: string;
    elevenlabsVoiceId: string;
    now?: Date;
  }): Promise<VoiceCloningJob> {
    const now = input.now ?? new Date();
    const [job] = await dbWrite
      .update(voiceCloningJobs)
      .set({
        status: "completed",
        userVoiceId: input.userVoiceId,
        elevenlabsVoiceId: input.elevenlabsVoiceId,
        progress: 100,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(voiceCloningJobs.id, input.jobId))
      .returning();
    if (!job) throw new Error("Failed to update voice cloning job");
    return job;
  }

  async deleteSamplesByJobId(jobId: string): Promise<void> {
    await dbWrite.delete(voiceSamples).where(eq(voiceSamples.jobId, jobId));
  }

  async markCloningJobFailed(jobId: string, errorMessage: string, now = new Date()): Promise<void> {
    await dbWrite
      .update(voiceCloningJobs)
      .set({ status: "failed", errorMessage, updatedAt: now })
      .where(eq(voiceCloningJobs.id, jobId));
  }

  async incrementUsageCount(voiceId: string): Promise<void> {
    await dbWrite
      .update(userVoices)
      .set({
        usageCount: sql`${userVoices.usageCount} + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(userVoices.id, voiceId));
  }
}

export const userVoicesRepository = new UserVoicesRepository();
