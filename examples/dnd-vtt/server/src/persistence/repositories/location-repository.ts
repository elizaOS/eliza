/**
 * Location Repository
 * Database operations for locations, battle maps, and NPCs
 */

import { eq, and, ilike } from 'drizzle-orm';
import { getDatabase, schema } from '../database';
import type { Location, BattleMap, NPC } from '../../types';

export interface CreateLocationInput {
  campaignId: string;
  name: string;
  type: string;
  description: string;
  parentLocationId?: string;
  tags?: string[];
  npcs?: string[];
  pointsOfInterest?: Array<{ name: string; description: string }>;
  availableServices?: string[];
  dangerLevel?: number;
}

export interface CreateBattleMapInput {
  locationId: string;
  campaignId: string;
  name: string;
  gridWidth: number;
  gridHeight: number;
  gridSize?: number;
  backgroundUrl?: string;
}

export interface CreateNPCInput {
  campaignId: string;
  name: string;
  type: string;
  race?: string;
  occupation?: string;
  description?: string;
  personality?: string;
  motivation?: string;
  secrets?: string[];
  locationId?: string;
  isHostile?: boolean;
  statBlock?: Record<string, unknown>;
}

export class LocationRepository {
  private db = () => getDatabase();
  private locs = () => schema.locations;
  private maps = () => schema.battleMaps;
  private npcs = () => schema.npcs;

  // Locations
  async create(input: CreateLocationInput): Promise<Location> {
    const [result] = await this.db().insert(this.locs()).values({
      campaignId: input.campaignId,
      name: input.name,
      type: input.type,
      description: input.description,
      parentLocationId: input.parentLocationId,
      tags: input.tags || [],
      npcs: input.npcs || [],
      pointsOfInterest: input.pointsOfInterest || [],
      availableServices: input.availableServices || [],
      dangerLevel: input.dangerLevel || 0,
    }).returning();
    return this.mapLocation(result);
  }

  async getById(id: string): Promise<Location | null> {
    const [result] = await this.db().select().from(this.locs()).where(eq(this.locs().id, id)).limit(1);
    return result ? this.mapLocation(result) : null;
  }

  async getByCampaign(campaignId: string): Promise<Location[]> {
    const results = await this.db().select().from(this.locs())
      .where(eq(this.locs().campaignId, campaignId))
      .orderBy(this.locs().name);
    return results.map(this.mapLocation);
  }

  async getChildLocations(parentId: string): Promise<Location[]> {
    const results = await this.db().select().from(this.locs())
      .where(eq(this.locs().parentLocationId, parentId))
      .orderBy(this.locs().name);
    return results.map(this.mapLocation);
  }

  async searchByName(campaignId: string, searchTerm: string): Promise<Location[]> {
    const results = await this.db().select().from(this.locs())
      .where(and(eq(this.locs().campaignId, campaignId), ilike(this.locs().name, `%${searchTerm}%`)))
      .limit(20);
    return results.map(this.mapLocation);
  }

  async update(id: string, input: Partial<CreateLocationInput>): Promise<Location | null> {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    const keys = ['name', 'type', 'description', 'parentLocationId', 'tags', 'npcs', 'pointsOfInterest', 'availableServices', 'dangerLevel'] as const;
    keys.forEach(k => { if (input[k] !== undefined) updateData[k] = input[k]; });
    const [result] = await this.db().update(this.locs()).set(updateData).where(eq(this.locs().id, id)).returning();
    return result ? this.mapLocation(result) : null;
  }

  async recordVisit(id: string): Promise<void> {
    const location = await this.getById(id);
    if (!location) return;
    await this.db().update(this.locs()).set({
      visitCount: (location.visitCount || 0) + 1,
      lastVisited: new Date(),
      updatedAt: new Date(),
    }).where(eq(this.locs().id, id));
  }

  // Battle Maps
  async createBattleMap(input: CreateBattleMapInput): Promise<BattleMap> {
    const [result] = await this.db().insert(this.maps()).values({
      locationId: input.locationId,
      campaignId: input.campaignId,
      name: input.name,
      gridWidth: input.gridWidth,
      gridHeight: input.gridHeight,
      gridSize: input.gridSize || 5,
      backgroundUrl: input.backgroundUrl,
      gridData: {},
      fogOfWar: [],
      markers: [],
    }).returning();
    return this.mapBattleMap(result);
  }

  async getBattleMaps(locationId: string): Promise<BattleMap[]> {
    const results = await this.db().select().from(this.maps()).where(eq(this.maps().locationId, locationId));
    return results.map(this.mapBattleMap);
  }

  async getBattleMapById(id: string): Promise<BattleMap | null> {
    const [result] = await this.db().select().from(this.maps()).where(eq(this.maps().id, id)).limit(1);
    return result ? this.mapBattleMap(result) : null;
  }

  async updateBattleMap(id: string, updates: Partial<Pick<BattleMap, 'gridData' | 'fogOfWar' | 'markers'>>): Promise<BattleMap | null> {
    const [result] = await this.db().update(this.maps()).set({ ...updates, updatedAt: new Date() }).where(eq(this.maps().id, id)).returning();
    return result ? this.mapBattleMap(result) : null;
  }

  // NPCs
  async createNPC(input: CreateNPCInput): Promise<NPC> {
    const [result] = await this.db().insert(this.npcs()).values({
      campaignId: input.campaignId,
      name: input.name,
      type: input.type,
      race: input.race,
      occupation: input.occupation,
      description: input.description,
      personality: input.personality,
      motivation: input.motivation,
      secrets: input.secrets || [],
      currentLocationId: input.locationId,
      isHostile: input.isHostile || false,
      statBlock: input.statBlock,
    }).returning();
    return this.mapNPC(result);
  }

  async getNPCById(id: string): Promise<NPC | null> {
    const [result] = await this.db().select().from(this.npcs()).where(eq(this.npcs().id, id)).limit(1);
    return result ? this.mapNPC(result) : null;
  }

  async getNPCsByCampaign(campaignId: string): Promise<NPC[]> {
    const results = await this.db().select().from(this.npcs())
      .where(and(eq(this.npcs().campaignId, campaignId), eq(this.npcs().isAlive, true)))
      .orderBy(this.npcs().name);
    return results.map(this.mapNPC);
  }

  async getNPCsAtLocation(locationId: string): Promise<NPC[]> {
    const results = await this.db().select().from(this.npcs())
      .where(and(eq(this.npcs().currentLocationId, locationId), eq(this.npcs().isAlive, true)))
      .orderBy(this.npcs().name);
    return results.map(this.mapNPC);
  }

  async moveNPC(id: string, locationId: string): Promise<void> {
    await this.db().update(this.npcs()).set({ currentLocationId: locationId, updatedAt: new Date() }).where(eq(this.npcs().id, id));
  }

  async updateNPCDisposition(id: string, disposition: number): Promise<void> {
    await this.db().update(this.npcs()).set({
      partyDisposition: Math.max(-100, Math.min(100, disposition)),
      updatedAt: new Date(),
    }).where(eq(this.npcs().id, id));
  }

  async killNPC(id: string): Promise<void> {
    await this.db().update(this.npcs()).set({ isAlive: false, updatedAt: new Date() }).where(eq(this.npcs().id, id));
  }

  async recordInteraction(id: string): Promise<void> {
    const npc = await this.getNPCById(id);
    if (!npc) return;
    await this.db().update(this.npcs()).set({
      interactionCount: (npc.interactionCount || 0) + 1,
      lastInteraction: new Date(),
      updatedAt: new Date(),
    }).where(eq(this.npcs().id, id));
  }

  // Mappers — map all schema fields to the type, casting extras that the schema
  // stores but the type interface doesn't explicitly list as `Record<string, unknown>`.
  private mapLocation = (row: typeof schema.locations.$inferSelect): Location & Record<string, unknown> => ({
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    type: row.type as Location['type'],
    description: row.description || '',
    parentLocationId: row.parentLocationId ?? undefined,
    tags: (row.tags as string[]) || [],
    npcs: (row.npcs as string[]) || [],
    pointsOfInterest: (row.pointsOfInterest as Location['pointsOfInterest']) || [],
    availableServices: (row.availableServices as string[]) || [],
    dangerLevel: row.dangerLevel || 0,
    visitCount: row.visitCount || 0,
    lastVisited: row.lastVisited ?? undefined,
    isDiscovered: row.isDiscovered || false,
    imageUrl: row.imageUrl ?? undefined,
    // Extra schema fields preserved for round-trip fidelity
    childLocationIds: (row.childLocationIds as string[]) ?? [],
    connections: (row.connections as Array<Record<string, unknown>>) ?? [],
    features: (row.features as string[]) ?? [],
    ambiance: (row.ambiance as string) ?? undefined,
    lighting: (row.lighting as string) ?? undefined,
    npcIds: (row.npcIds as string[]) ?? [],
    monsterIds: (row.monsterIds as string[]) ?? [],
    loot: (row.loot as string[]) ?? [],
    discovered: row.discovered ?? false,
    cleared: row.cleared ?? false,
    notes: (row.notes as string) ?? undefined,
    battleMapId: (row.battleMapId as string) ?? undefined,
  });

  private mapBattleMap = (row: typeof schema.battleMaps.$inferSelect): BattleMap & Record<string, unknown> => ({
    id: row.id,
    locationId: row.locationId,
    campaignId: row.campaignId,
    name: row.name,
    gridWidth: row.gridWidth,
    gridHeight: row.gridHeight,
    gridSize: row.gridSize || 5,
    backgroundUrl: row.backgroundUrl ?? undefined,
    gridData: (row.gridData as BattleMap['gridData']) || {},
    fogOfWar: (row.fogOfWar as BattleMap['fogOfWar']) || [],
    markers: (row.markers as BattleMap['markers']) || [],
    // Extra schema fields preserved for round-trip fidelity
    backgroundColor: (row.backgroundColor as string) ?? undefined,
    showGrid: row.showGrid ?? true,
    gridColor: (row.gridColor as string) ?? undefined,
    gridOpacity: (row.gridOpacity as number) ?? 0.3,
  });

  private mapNPC = (row: typeof schema.npcs.$inferSelect): NPC => ({
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    type: row.type as NPC['type'],
    race: row.race ?? undefined,
    occupation: row.occupation ?? undefined,
    description: row.description ?? undefined,
    personality: row.personality ?? undefined,
    motivation: row.motivation ?? undefined,
    secrets: (row.secrets as string[]) || [],
    currentLocationId: row.currentLocationId ?? undefined,
    isAlive: row.isAlive ?? true,
    isHostile: row.isHostile ?? false,
    partyDisposition: row.partyDisposition || 0,
    interactionCount: row.interactionCount || 0,
    lastInteraction: row.lastInteraction ?? undefined,
    statBlock: row.statBlock as NPC['statBlock'],
    portraitUrl: row.portraitUrl ?? undefined,
  });
}

export const locationRepository = new LocationRepository();
