/**
 * Campaign Repository
 * Database operations for campaigns and sessions
 */

import { eq, desc } from 'drizzle-orm';
import { getDatabase, schema } from '../database';
import type { Campaign, Session, SessionSummary, GameTime, CampaignSettings } from '../../types';

const DEFAULT_SETTINGS: CampaignSettings = {
  maxPartySize: 6,
  startingLevel: 1,
  allowPvP: false,
  deathRules: 'standard',
  restRules: 'standard',
  encumbranceRules: 'none',
};

const DEFAULT_TIME: GameTime = { year: 1490, month: 1, day: 1, hour: 8, minute: 0 };

export interface CreateCampaignInput {
  name: string;
  description?: string;
  dmAgentId: string;
  dmCharacterName?: string;
  settings?: Partial<CampaignSettings>;
  // Fields used by seed data
  startingLocationId?: string;
  setting?: string;
  tone?: string;
  themes?: string[];
  sessionCount?: number;
  totalPlayTime?: number;
  status?: string;
}

export type UpdateCampaignInput = Partial<Pick<Campaign, 'name' | 'description' | 'currentLocationId' | 'currentTime' | 'settings'>> & {
  startingLocationId?: string;
};

export class CampaignRepository {
  private db = () => getDatabase();
  private campaigns = () => schema.campaigns;
  private sessions = () => schema.sessions;

  async create(input: CreateCampaignInput): Promise<Campaign> {
    const [result] = await this.db().insert(this.campaigns()).values({
      name: input.name,
      description: input.description,
      dmAgentId: input.dmAgentId ?? crypto.randomUUID(),
      dmCharacterName: input.dmCharacterName || 'Dungeon Master',
      settings: { ...DEFAULT_SETTINGS, ...input.settings },
      currentTime: DEFAULT_TIME,
    }).returning();
    return this.mapCampaign(result);
  }

  async getById(id: string): Promise<Campaign | null> {
    const [result] = await this.db().select().from(this.campaigns()).where(eq(this.campaigns().id, id)).limit(1);
    return result ? this.mapCampaign(result) : null;
  }

  async list(): Promise<Campaign[]> {
    const results = await this.db().select().from(this.campaigns()).orderBy(desc(this.campaigns().updatedAt));
    return results.map(this.mapCampaign);
  }

  async update(id: string, input: Partial<Pick<Campaign, 'name' | 'description' | 'currentLocationId' | 'currentTime' | 'settings'>>): Promise<Campaign | null> {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.currentLocationId !== undefined) updateData.currentLocationId = input.currentLocationId || null;
    if (input.currentTime !== undefined) updateData.currentTime = input.currentTime;
    if (input.settings !== undefined) {
      const existing = await this.getById(id);
      if (existing) updateData.settings = { ...existing.settings, ...input.settings };
    }
    const [result] = await this.db().update(this.campaigns()).set(updateData).where(eq(this.campaigns().id, id)).returning();
    return result ? this.mapCampaign(result) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db().delete(this.campaigns()).where(eq(this.campaigns().id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Sessions
  async createSession(campaignId: string, startingLocationId?: string, startingTime?: GameTime): Promise<Session> {
    const [lastSession] = await this.db().select().from(this.sessions())
      .where(eq(this.sessions().campaignId, campaignId))
      .orderBy(desc(this.sessions().sessionNumber))
      .limit(1);

    const [result] = await this.db().insert(this.sessions()).values({
      campaignId,
      sessionNumber: (lastSession?.sessionNumber || 0) + 1,
      startingLocationId: startingLocationId || undefined,
      startingTime,
    }).returning();

    // Increment session count
    const campaign = await this.getById(campaignId);
    if (campaign) {
      await this.db().update(this.campaigns()).set({
        sessionCount: (campaign.sessionCount ?? 0) + 1,
        updatedAt: new Date(),
      }).where(eq(this.campaigns().id, campaignId));
    }

    return this.mapSession(result);
  }

  async getSessionById(id: string): Promise<Session | null> {
    const [result] = await this.db().select().from(this.sessions()).where(eq(this.sessions().id, id)).limit(1);
    return result ? this.mapSession(result) : null;
  }

  async getLatestSession(campaignId: string): Promise<Session | null> {
    const [result] = await this.db().select().from(this.sessions())
      .where(eq(this.sessions().campaignId, campaignId))
      .orderBy(desc(this.sessions().sessionNumber))
      .limit(1);
    return result ? this.mapSession(result) : null;
  }

  async endSession(id: string, endingLocationId?: string, endingTime?: GameTime, summary?: SessionSummary): Promise<Session | null> {
    const session = await this.getSessionById(id);
    if (!session) return null;

    const endedAt = new Date();
    const duration = Math.floor((endedAt.getTime() - session.startedAt.getTime()) / 60000);

    const [result] = await this.db().update(this.sessions())
      .set({ endedAt, duration, endingLocationId: endingLocationId || undefined, endingTime, summary })
      .where(eq(this.sessions().id, id))
      .returning();

    if (result) {
      const campaign = await this.getById(session.campaignId);
      if (campaign) {
        await this.db().update(this.campaigns()).set({
          totalPlayTime: (campaign.totalPlayTime ?? 0) + duration,
          updatedAt: new Date(),
        }).where(eq(this.campaigns().id, session.campaignId));
      }
    }

    return result ? this.mapSession(result) : null;
  }

  // These methods are called by session-manager; some overlap with createSession/endSession
  async incrementSessionCount(campaignId: string): Promise<void> {
    const campaign = await this.getById(campaignId);
    if (!campaign) return;
    await this.db().update(this.campaigns()).set({
      sessionCount: (campaign.sessionCount ?? 0) + 1,
      updatedAt: new Date(),
    }).where(eq(this.campaigns().id, campaignId));
  }

  async addPlayTime(campaignId: string, minutes: number): Promise<void> {
    const campaign = await this.getById(campaignId);
    if (!campaign) return;
    await this.db().update(this.campaigns()).set({
      totalPlayTime: (campaign.totalPlayTime ?? 0) + minutes,
      updatedAt: new Date(),
    }).where(eq(this.campaigns().id, campaignId));
  }

  async saveStateSnapshot(sessionId: string, snapshot: string): Promise<void> {
    await this.db().update(this.sessions()).set({
      stateSnapshot: snapshot,
    }).where(eq(this.sessions().id, sessionId));
  }

  private mapCampaign = (row: typeof schema.campaigns.$inferSelect): Campaign => ({
    id: row.id,
    name: row.name,
    description: row.description || '',
    dmAgentId: row.dmAgentId ?? undefined,
    dmCharacterName: row.dmCharacterName || 'Dungeon Master',
    settings: row.settings as CampaignSettings,
    currentTime: row.currentTime as GameTime,
    currentLocationId: row.currentLocationId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    totalPlayTime: row.totalPlayTime || 0,
    sessionCount: row.sessionCount || 0,
  });

  private mapSession = (row: typeof schema.sessions.$inferSelect): Session => ({
    id: row.id,
    campaignId: row.campaignId,
    sessionNumber: row.sessionNumber,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? undefined,
    duration: row.duration ?? undefined,
    startingLocationId: row.startingLocationId ?? '',
    endingLocationId: row.endingLocationId ?? undefined,
    startingTime: row.startingTime as GameTime,
    endingTime: row.endingTime as GameTime | undefined,
    summary: row.summary as SessionSummary | undefined,
    stateSnapshot: row.stateSnapshot ?? undefined,
    playerCharacterIds: (row.playerCharacterIds as string[]) || [],
    activeNpcIds: (row.activeNpcIds as string[]) || [],
  });
}

export const campaignRepository = new CampaignRepository();
