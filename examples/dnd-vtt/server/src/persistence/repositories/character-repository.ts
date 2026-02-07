/**
 * Character Repository
 * Database operations for characters, memories, and relationships
 */

import { eq, and, desc, gte } from 'drizzle-orm';
import { getDatabase, schema } from '../database';
import type { CharacterSheet, CharacterMemory, CharacterRelationship, GameTime } from '../../types';

export interface CreateCharacterInput {
  campaignId: string;
  playerType?: 'human' | 'ai';
  agentId?: string;
  sheet?: CharacterSheet;
  portraitUrl?: string;
  tokenUrl?: string;
  // Allow passing CharacterSheet fields directly (for seed compatibility)
  [key: string]: unknown;
}

export type UpdateCharacterInput = Partial<Pick<{
  sheet: CharacterSheet;
  currentHP: number;
  level: number;
  portraitUrl: string;
  tokenUrl: string;
  isActive: boolean;
}, 'sheet' | 'currentHP' | 'level' | 'portraitUrl' | 'tokenUrl' | 'isActive'>>;

export interface CreateMemoryInput {
  characterId: string;
  campaignId: string;
  type: string;
  content: string;
  sessionId?: string;
  gameTime?: GameTime;
  locationId?: string;
  relatedEntityIds?: string[];
  importance?: number;
  emotionalValence?: number;
}

export class CharacterRepository {
  private db = () => getDatabase();
  private chars = () => schema.characters;
  private mems = () => schema.characterMemories;
  private rels = () => schema.characterRelationships;

  // Character CRUD
  async create(input: CreateCharacterInput): Promise<CharacterSheet> {
    // Support both { sheet: CharacterSheet } and direct CharacterSheet fields
    // When no sheet is provided, the input itself carries CharacterSheet fields (seed compat)
    const sheet: CharacterSheet = input.sheet ?? this.extractSheet(input);
    const hp = sheet.hp ?? sheet.hitPoints ?? { current: 1, max: 1 };
    const playerType = input.playerType ?? (sheet.isAI ? 'ai' : 'human');

    const [result] = await this.db().insert(this.chars()).values({
      campaignId: input.campaignId,
      playerType,
      agentId: input.agentId,
      name: sheet.name,
      sheet,
      race: sheet.race,
      className: sheet.class,
      level: sheet.level,
      currentHP: hp.current,
      maxHP: hp.max,
      portraitUrl: input.portraitUrl ?? sheet.portraitUrl,
      tokenUrl: input.tokenUrl ?? sheet.tokenUrl,
    }).returning();
    return { ...sheet, id: result.id };
  }

  async getById(id: string): Promise<CharacterSheet | null> {
    const [result] = await this.db().select().from(this.chars()).where(eq(this.chars().id, id)).limit(1);
    return result ? { ...(result.sheet as CharacterSheet), id: result.id } : null;
  }

  async getByCampaign(campaignId: string): Promise<CharacterSheet[]> {
    const results = await this.db().select().from(this.chars())
      .where(and(eq(this.chars().campaignId, campaignId), eq(this.chars().isActive, true)))
      .orderBy(this.chars().name);
    return results.map(r => ({ ...(r.sheet as CharacterSheet), id: r.id }));
  }

  async getAICharacters(campaignId: string): Promise<CharacterSheet[]> {
    const results = await this.db().select().from(this.chars())
      .where(and(eq(this.chars().campaignId, campaignId), eq(this.chars().playerType, 'ai'), eq(this.chars().isActive, true)));
    return results.map(r => ({ ...(r.sheet as CharacterSheet), id: r.id }));
  }

  async update(id: string, input: UpdateCharacterInput): Promise<CharacterSheet | null> {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.sheet) {
      const { sheet } = input;
      const hp = sheet.hp ?? sheet.hitPoints ?? { current: 1, max: 1 };
      Object.assign(updateData, { sheet, name: sheet.name, race: sheet.race, className: sheet.class, level: sheet.level, currentHP: hp.current, maxHP: hp.max });
    }
    if (input.currentHP !== undefined) updateData.currentHP = input.currentHP;
    if (input.level !== undefined) updateData.level = input.level;
    if (input.portraitUrl !== undefined) updateData.portraitUrl = input.portraitUrl;
    if (input.tokenUrl !== undefined) updateData.tokenUrl = input.tokenUrl;
    if (input.isActive !== undefined) updateData.isActive = input.isActive;

    const [result] = await this.db().update(this.chars()).set(updateData).where(eq(this.chars().id, id)).returning();
    return result ? { ...(result.sheet as CharacterSheet), id: result.id } : null;
  }

  async updateHP(id: string, currentHP: number): Promise<void> {
    const character = await this.getById(id);
    if (!character) return;
    const hp = character.hp ?? character.hitPoints;
    if (hp) hp.current = currentHP;
    await this.db().update(this.chars()).set({ currentHP, sheet: character, updatedAt: new Date() }).where(eq(this.chars().id, id));
  }

  async updateSheet(id: string, sheet: CharacterSheet): Promise<void> {
    const hp = sheet.hp ?? sheet.hitPoints ?? { current: 1, max: 1 };
    await this.db().update(this.chars()).set({
      sheet,
      currentHP: hp.current,
      maxHP: hp.max,
      level: sheet.level,
      updatedAt: new Date(),
    }).where(eq(this.chars().id, id));
  }

  async levelUp(id: string, newLevel: number): Promise<void> {
    const character = await this.getById(id);
    if (!character) return;
    character.level = newLevel;
    await this.db().update(this.chars()).set({ level: newLevel, sheet: character, updatedAt: new Date() }).where(eq(this.chars().id, id));
  }

  // Memories
  async addMemory(input: CreateMemoryInput): Promise<CharacterMemory> {
    const [result] = await this.db().insert(this.mems()).values({
      characterId: input.characterId,
      campaignId: input.campaignId,
      type: input.type,
      content: input.content,
      sessionId: input.sessionId || undefined,
      gameTime: input.gameTime,
      locationId: input.locationId || undefined,
      relatedEntityIds: input.relatedEntityIds || [],
      importance: input.importance || 5,
      emotionalValence: input.emotionalValence || 0,
    }).returning();
    return this.mapMemory(result);
  }

  async getMemories(characterId: string, opts?: { type?: string; minImportance?: number; limit?: number }): Promise<CharacterMemory[]> {
    const conditions = [eq(this.mems().characterId, characterId)];
    if (opts?.type) conditions.push(eq(this.mems().type, opts.type));
    if (opts?.minImportance) conditions.push(gte(this.mems().importance, opts.minImportance));

    const results = await this.db().select().from(this.mems())
      .where(and(...conditions))
      .orderBy(desc(this.mems().importance), desc(this.mems().createdAt))
      .limit(opts?.limit || 100);
    return results.map(this.mapMemory);
  }

  async getImportantMemories(characterId: string, limit = 10): Promise<CharacterMemory[]> {
    return this.getMemories(characterId, { minImportance: 5, limit });
  }

  async getRecentMemories(characterId: string, limit = 10): Promise<CharacterMemory[]> {
    const results = await this.db().select().from(this.mems())
      .where(eq(this.mems().characterId, characterId))
      .orderBy(desc(this.mems().createdAt))
      .limit(limit);
    return results.map(this.mapMemory);
  }

  // Relationships
  async getOrCreateRelationship(characterId: string, targetId: string, targetType: 'pc' | 'npc', targetName: string): Promise<CharacterRelationship> {
    const [existing] = await this.db().select().from(this.rels())
      .where(and(eq(this.rels().characterId, characterId), eq(this.rels().targetId, targetId)))
      .limit(1);
    if (existing) return this.mapRelationship(existing);

    const [result] = await this.db().insert(this.rels()).values({
      characterId, targetId, targetType, targetName,
      disposition: 0, trust: 50, familiarity: 0, significantInteractions: [],
    }).returning();
    return this.mapRelationship(result);
  }

  async updateRelationship(characterId: string, targetId: string, updates: { disposition?: number; trust?: number; familiarity?: number; addInteraction?: string; targetType?: 'pc' | 'npc'; targetName?: string }): Promise<CharacterRelationship | null> {
    const targetType = updates.targetType ?? 'pc';
    const targetName = updates.targetName ?? targetId;
    const existing = await this.getOrCreateRelationship(characterId, targetId, targetType, targetName);
    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (updates.disposition !== undefined) updateData.disposition = Math.max(-100, Math.min(100, updates.disposition));
    if (updates.trust !== undefined) updateData.trust = Math.max(0, Math.min(100, updates.trust));
    if (updates.familiarity !== undefined) updateData.familiarity = Math.max(0, Math.min(100, updates.familiarity));
    if (updates.addInteraction) updateData.significantInteractions = [...existing.significantInteractions, updates.addInteraction].slice(-20);

    const [result] = await this.db().update(this.rels())
      .set(updateData)
      .where(and(eq(this.rels().characterId, characterId), eq(this.rels().targetId, targetId)))
      .returning();
    return result ? this.mapRelationship(result) : null;
  }

  async getRelationships(characterId: string): Promise<CharacterRelationship[]> {
    const results = await this.db().select().from(this.rels())
      .where(eq(this.rels().characterId, characterId))
      .orderBy(desc(this.rels().familiarity));
    return results.map(this.mapRelationship);
  }

  /**
   * Extract CharacterSheet fields from a CreateCharacterInput that carries them directly.
   * This avoids `as unknown as CharacterSheet` by explicitly picking known fields.
   */
  private extractSheet(input: CreateCharacterInput): CharacterSheet {
    const raw = input as Record<string, unknown>;
    return {
      id: raw.id as string | undefined,
      name: raw.name as string,
      race: raw.race as string,
      class: raw.class as string,
      level: raw.level as number ?? 1,
      hp: raw.hp as CharacterSheet['hp'],
      hitPoints: raw.hitPoints as CharacterSheet['hitPoints'],
      abilities: raw.abilities as CharacterSheet['abilities'],
      armorClass: raw.armorClass as number ?? 10,
      ac: raw.ac as number ?? 10,
      speed: raw.speed as number ?? 30,
      isAI: raw.isAI as boolean ?? false,
      portraitUrl: raw.portraitUrl as string | undefined,
      tokenUrl: raw.tokenUrl as string | undefined,
    } as CharacterSheet;
  }

  // Mappers
  private mapMemory = (row: typeof schema.characterMemories.$inferSelect): CharacterMemory => ({
    id: row.id,
    characterId: row.characterId,
    campaignId: row.campaignId,
    type: row.type as CharacterMemory['type'],
    content: row.content,
    sessionId: row.sessionId ?? '',
    gameTime: row.gameTime as GameTime,
    locationId: row.locationId ?? undefined,
    relatedEntityIds: (row.relatedEntityIds as string[]) || [],
    importance: row.importance,
    emotionalValence: row.emotionalValence || 0,
    createdAt: row.createdAt,
    embeddingId: row.embeddingId ?? undefined,
  });

  private mapRelationship = (row: typeof schema.characterRelationships.$inferSelect): CharacterRelationship => ({
    id: row.id,
    characterId: row.characterId,
    targetId: row.targetId,
    targetType: row.targetType as 'pc' | 'npc',
    targetName: row.targetName,
    disposition: row.disposition || 0,
    trust: row.trust || 50,
    familiarity: row.familiarity || 0,
    significantInteractions: (row.significantInteractions as string[]) || [],
    updatedAt: row.updatedAt,
  });
}

export const characterRepository = new CharacterRepository();
