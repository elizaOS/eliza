/**
 * World Repository
 * Database operations for world events, quests, items, and combat logs
 */

import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { getDatabase, schema } from '../database';
import type { WorldEvent, Quest, GameTime, Item } from '../../types';

export interface CreateWorldEventInput {
  campaignId: string;
  sessionId?: string;
  type: string;
  description: string;
  gameTime?: GameTime;
  locationId?: string;
  involvedEntityIds?: string[];
  consequences?: string[];
  importance?: number;
}

export interface CreateQuestInput {
  campaignId: string;
  name: string;
  description: string;
  type: string;
  giver?: string;
  locationId?: string;
  objectives: Array<{ description: string }>;
  rewards?: { experience?: number; gold?: number; items?: string[] };
  importance?: number;
}

export interface CreateItemInput {
  campaignId: string;
  name: string;
  type: string;
  rarity?: string;
  description?: string;
  properties?: Record<string, unknown>;
  weight?: number;
  value?: number;
  ownerId?: string;
  ownerType?: 'character' | 'npc' | 'location';
}

export interface CreateCombatLogInput {
  campaignId: string;
  sessionId: string;
  encounterId: string;
  roundNumber: number;
  turnOrder: number;
  actorId: string;
  actorName: string;
  actionType: string;
  actionDescription: string;
  targetIds?: string[];
  diceRolls?: Array<{ notation: string; result: number; purpose: string }>;
  damage?: number;
  healing?: number;
  outcome?: string;
  gameTime?: GameTime;
}

export class WorldRepository {
  private db = () => getDatabase();
  private events = () => schema.worldEvents;
  private quests = () => schema.quests;
  private items = () => schema.items;
  private combatLogs = () => schema.combatLogs;

  // Events
  async createEvent(input: CreateWorldEventInput): Promise<WorldEvent> {
    const [result] = await this.db().insert(this.events()).values({
      campaignId: input.campaignId,
      sessionId: input.sessionId || undefined,
      type: input.type,
      description: input.description,
      gameTime: input.gameTime,
      locationId: input.locationId || undefined,
      involvedEntityIds: input.involvedEntityIds || [],
      consequences: input.consequences || [],
      importance: input.importance || 5,
    }).returning();
    return this.mapEvent(result);
  }

  async getEvents(campaignId: string, opts?: { type?: string; minImportance?: number; sessionId?: string; limit?: number }): Promise<WorldEvent[]> {
    const conditions = [eq(this.events().campaignId, campaignId)];
    if (opts?.type) conditions.push(eq(this.events().type, opts.type));
    if (opts?.minImportance) conditions.push(gte(this.events().importance, opts.minImportance));
    if (opts?.sessionId) conditions.push(eq(this.events().sessionId, opts.sessionId));

    const results = await this.db().select().from(this.events())
      .where(and(...conditions))
      .orderBy(desc(this.events().createdAt))
      .limit(opts?.limit || 100);
    return results.map(this.mapEvent);
  }

  async getEventsAtLocation(locationId: string): Promise<WorldEvent[]> {
    const results = await this.db().select().from(this.events())
      .where(eq(this.events().locationId, locationId))
      .orderBy(desc(this.events().createdAt))
      .limit(50);
    return results.map(this.mapEvent);
  }

  async getRecentImportantEvents(campaignId: string, limit = 10): Promise<WorldEvent[]> {
    const results = await this.db().select().from(this.events())
      .where(and(eq(this.events().campaignId, campaignId), gte(this.events().importance, 3)))
      .orderBy(desc(this.events().createdAt))
      .limit(limit);
    return results.map(this.mapEvent);
  }

  // Quests
  async getActiveQuests(campaignId: string): Promise<Quest[]> {
    return this.getQuests(campaignId, 'active');
  }

  async createQuest(input: CreateQuestInput): Promise<Quest> {
    const objectives = input.objectives.map(obj => ({
      id: crypto.randomUUID(),
      description: obj.description,
      isComplete: false,
    }));
    const [result] = await this.db().insert(this.quests()).values({
      campaignId: input.campaignId,
      name: input.name,
      description: input.description,
      type: input.type,
      status: 'available',
      giver: input.giver,
      locationId: input.locationId || undefined,
      objectives,
      rewards: input.rewards || {},
      importance: input.importance || 5,
    }).returning();
    return this.mapQuest(result);
  }

  async getQuestById(id: string): Promise<Quest | null> {
    const [result] = await this.db().select().from(this.quests()).where(eq(this.quests().id, id)).limit(1);
    return result ? this.mapQuest(result) : null;
  }

  async getQuests(campaignId: string, status?: string): Promise<Quest[]> {
    const conditions = [eq(this.quests().campaignId, campaignId)];
    if (status) conditions.push(eq(this.quests().status, status));
    const results = await this.db().select().from(this.quests())
      .where(and(...conditions))
      .orderBy(desc(this.quests().importance), this.quests().name);
    return results.map(this.mapQuest);
  }

  async acceptQuest(id: string): Promise<Quest | null> {
    const [result] = await this.db().update(this.quests())
      .set({ status: 'active', acceptedAt: new Date(), updatedAt: new Date() })
      .where(eq(this.quests().id, id))
      .returning();
    return result ? this.mapQuest(result) : null;
  }

  async completeObjective(questId: string, objectiveId: string): Promise<Quest | null> {
    const quest = await this.getQuestById(questId);
    if (!quest) return null;

    const updatedObjectives = quest.objectives.map(obj =>
      obj.id === objectiveId ? { ...obj, isComplete: true, completedAt: new Date() } : obj
    );
    const allComplete = updatedObjectives.every(obj => obj.isComplete);
    const updateData: Record<string, unknown> = { objectives: updatedObjectives, updatedAt: new Date() };
    if (allComplete) Object.assign(updateData, { status: 'completed', completedAt: new Date() });

    const [result] = await this.db().update(this.quests()).set(updateData).where(eq(this.quests().id, questId)).returning();
    return result ? this.mapQuest(result) : null;
  }

  async failQuest(id: string): Promise<Quest | null> {
    const [result] = await this.db().update(this.quests())
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(this.quests().id, id))
      .returning();
    return result ? this.mapQuest(result) : null;
  }

  // Items
  async createItem(input: CreateItemInput): Promise<Item> {
    const [result] = await this.db().insert(this.items()).values({
      campaignId: input.campaignId,
      name: input.name,
      type: input.type,
      rarity: input.rarity || 'common',
      description: input.description,
      properties: input.properties || {},
      weight: input.weight || 0,
      value: input.value || 0,
      ownerId: input.ownerId,
      ownerType: input.ownerType,
    }).returning();
    return this.mapItem(result);
  }

  async getItemById(id: string): Promise<Item | null> {
    const [result] = await this.db().select().from(this.items()).where(eq(this.items().id, id)).limit(1);
    return result ? this.mapItem(result) : null;
  }

  async getItemsByOwner(ownerId: string): Promise<Item[]> {
    const results = await this.db().select().from(this.items())
      .where(eq(this.items().ownerId, ownerId))
      .orderBy(this.items().name);
    return results.map(this.mapItem);
  }

  async transferItem(itemId: string, newOwnerId: string, newOwnerType: 'character' | 'npc' | 'location'): Promise<Item | null> {
    const [result] = await this.db().update(this.items())
      .set({ ownerId: newOwnerId, ownerType: newOwnerType, updatedAt: new Date() })
      .where(eq(this.items().id, itemId))
      .returning();
    return result ? this.mapItem(result) : null;
  }

  // Combat Logs
  async logCombatAction(input: CreateCombatLogInput): Promise<void> {
    await this.db().insert(this.combatLogs()).values({
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      encounterId: input.encounterId,
      roundNumber: input.roundNumber,
      turnOrder: input.turnOrder,
      actorId: input.actorId,
      actorName: input.actorName,
      actionType: input.actionType,
      actionDescription: input.actionDescription,
      targetIds: input.targetIds || [],
      diceRolls: input.diceRolls || [],
      damage: input.damage,
      healing: input.healing,
      outcome: input.outcome,
      gameTime: input.gameTime,
    });
  }

  async getCombatLog(encounterId: string) {
    const results = await this.db().select().from(this.combatLogs())
      .where(eq(this.combatLogs().encounterId, encounterId))
      .orderBy(this.combatLogs().roundNumber, this.combatLogs().turnOrder);
    return results.map(r => ({
      roundNumber: r.roundNumber,
      turnOrder: r.turnOrder,
      actorName: r.actorName,
      actionType: r.actionType,
      actionDescription: r.actionDescription,
      outcome: r.outcome ?? undefined,
    }));
  }

  async getCharacterCombatStats(characterId: string) {
    const [dmg] = await this.db().select({ total: sql<number>`COALESCE(SUM(${this.combatLogs().damage}), 0)` })
      .from(this.combatLogs()).where(eq(this.combatLogs().actorId, characterId));
    const [heal] = await this.db().select({ total: sql<number>`COALESCE(SUM(${this.combatLogs().healing}), 0)` })
      .from(this.combatLogs()).where(eq(this.combatLogs().actorId, characterId));
    const [enc] = await this.db().select({ count: sql<number>`COUNT(DISTINCT ${this.combatLogs().encounterId})` })
      .from(this.combatLogs()).where(eq(this.combatLogs().actorId, characterId));
    // Calculate damage taken: sum of damage from entries where this character was a target
    const [taken] = await this.db().select({ total: sql<number>`COALESCE(SUM(${this.combatLogs().damage}), 0)` })
      .from(this.combatLogs())
      .where(sql`${characterId} = ANY(${this.combatLogs().targetIds})`);
    return {
      totalDamageDealt: dmg?.total || 0,
      totalDamageTaken: taken?.total || 0,
      totalHealing: heal?.total || 0,
      encountersParticipated: enc?.count || 0,
    };
  }

  // Mappers
  private mapEvent = (row: typeof schema.worldEvents.$inferSelect): WorldEvent => ({
    id: row.id,
    campaignId: row.campaignId,
    sessionId: row.sessionId ?? '',
    type: row.type as WorldEvent['type'],
    description: row.description,
    gameTime: row.gameTime as GameTime,
    locationId: row.locationId ?? undefined,
    involvedEntityIds: (row.involvedEntityIds as string[]) || [],
    consequences: (row.consequences as string[]) || [],
    importance: row.importance ?? 5,
    createdAt: row.createdAt,
  });

  private mapQuest = (row: typeof schema.quests.$inferSelect): Quest => ({
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    description: row.description ?? '',
    type: row.type as Quest['type'],
    status: row.status as Quest['status'],
    giver: row.giver ?? undefined,
    locationId: row.locationId ?? undefined,
    objectives: (row.objectives as Quest['objectives']) || [],
    rewards: (row.rewards as Quest['rewards']) || {},
    importance: row.importance ?? undefined,
    acceptedAt: row.acceptedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  });

  private mapItem = (row: typeof schema.items.$inferSelect): Item & Record<string, unknown> => ({
    id: row.id,
    name: row.name,
    type: row.type as Item['type'],
    rarity: row.rarity as Item['rarity'],
    description: row.description || '',
    attuned: row.attuned ?? false,
    equipped: row.equipped ?? false,
    weight: row.weight ?? undefined,
    value: row.value ?? undefined,
    properties: row.properties as Record<string, unknown>,
    // Ownership fields preserved for round-trip fidelity
    ownerId: row.ownerId ?? undefined,
    ownerType: row.ownerType as 'character' | 'npc' | 'location' | undefined,
  });
}

export const worldRepository = new WorldRepository();
