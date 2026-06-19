import { logger } from "@elizaos/core";

/**
 * A named group of voice targets
 */
export interface Zone {
  name: string;
  targetIds: string[];
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/**
 * ZoneManager manages logical groupings of voice targets
 * Zones allow routing audio to named collections of targets
 */
export class ZoneManager {
  private zones: Map<string, Zone> = new Map();

  /**
   * Create a new zone
   * @param name Zone name
   * @param targetIds Array of target IDs in this zone
   * @param metadata Optional metadata for the zone
   */
  create(
    name: string,
    targetIds: string[],
    metadata?: Record<string, unknown>,
  ): Zone {
    if (this.zones.has(name)) {
      throw new Error(`Zone ${name} already exists`);
    }

    const zone: Zone = {
      name,
      targetIds: [...targetIds], // Clone array
      createdAt: Date.now(),
      metadata,
    };

    this.zones.set(name, zone);
    logger.log(
      `[ZoneManager] Created zone: ${name} with ${targetIds.length} target(s)`,
    );

    return zone;
  }

  /**
   * Delete a zone
   */
  delete(name: string): boolean {
    const deleted = this.zones.delete(name);
    if (deleted) {
      logger.log(`[ZoneManager] Deleted zone: ${name}`);
    }
    return deleted;
  }

  /**
   * Get a zone by name
   */
  get(name: string): Zone | undefined {
    return this.zones.get(name);
  }

  /**
   * Get all zones
   */
  list(): Zone[] {
    return Array.from(this.zones.values());
  }

  /**
   * Check if a zone exists
   */
  exists(name: string): boolean {
    return this.zones.has(name);
  }

  /**
   * Add target to a zone
   */
  addTarget(zoneName: string, targetId: string): void {
    const zone = this.zones.get(zoneName);
    if (!zone) {
      throw new Error(`Zone ${zoneName} not found`);
    }

    if (zone.targetIds.includes(targetId)) {
      logger.warn(
        `[ZoneManager] Target ${targetId} already in zone ${zoneName}`,
      );
      return;
    }

    zone.targetIds.push(targetId);
    logger.log(`[ZoneManager] Added target ${targetId} to zone ${zoneName}`);
  }

  /**
   * Remove target from a zone
   */
  removeTarget(zoneName: string, targetId: string): void {
    const zone = this.zones.get(zoneName);
    if (!zone) {
      throw new Error(`Zone ${zoneName} not found`);
    }

    const index = zone.targetIds.indexOf(targetId);
    if (index === -1) {
      logger.warn(`[ZoneManager] Target ${targetId} not in zone ${zoneName}`);
      return;
    }

    zone.targetIds.splice(index, 1);
    logger.log(
      `[ZoneManager] Removed target ${targetId} from zone ${zoneName}`,
    );
  }

  /**
   * Get all target IDs in a zone
   */
  getTargets(zoneName: string): string[] {
    const zone = this.zones.get(zoneName);
    if (!zone) {
      throw new Error(`Zone ${zoneName} not found`);
    }
    return [...zone.targetIds]; // Return clone
  }

  /**
   * Update zone metadata
   */
  updateMetadata(zoneName: string, metadata: Record<string, unknown>): void {
    const zone = this.zones.get(zoneName);
    if (!zone) {
      throw new Error(`Zone ${zoneName} not found`);
    }

    zone.metadata = { ...zone.metadata, ...metadata };
    logger.log(`[ZoneManager] Updated metadata for zone ${zoneName}`);
  }

  /**
   * Find all zones containing a specific target
   */
  findZonesWithTarget(targetId: string): Zone[] {
    const result: Zone[] = [];
    for (const zone of this.zones.values()) {
      if (zone.targetIds.includes(targetId)) {
        result.push(zone);
      }
    }
    return result;
  }

  /**
   * Clear all zones
   */
  clear(): void {
    this.zones.clear();
    logger.log("[ZoneManager] Cleared all zones");
  }

  /**
   * Get zone count
   */
  count(): number {
    return this.zones.size;
  }

  /**
   * Merge multiple zones into a new zone
   */
  merge(newZoneName: string, zoneNames: string[]): Zone {
    const targetIds = new Set<string>();

    for (const zoneName of zoneNames) {
      const zone = this.zones.get(zoneName);
      if (!zone) {
        throw new Error(`Zone ${zoneName} not found`);
      }
      for (const targetId of zone.targetIds) {
        targetIds.add(targetId);
      }
    }

    return this.create(newZoneName, Array.from(targetIds), {
      mergedFrom: zoneNames,
    });
  }

  /**
   * Clone a zone with a new name
   */
  clone(sourceName: string, newName: string): Zone {
    const source = this.zones.get(sourceName);
    if (!source) {
      throw new Error(`Zone ${sourceName} not found`);
    }

    return this.create(newName, [...source.targetIds], {
      ...source.metadata,
      clonedFrom: sourceName,
    });
  }

  /**
   * Get targets that are in multiple zones (intersection)
   */
  getIntersection(zoneNames: string[]): string[] {
    if (zoneNames.length === 0) return [];

    const firstZone = this.zones.get(zoneNames[0]);
    if (!firstZone) {
      throw new Error(`Zone ${zoneNames[0]} not found`);
    }

    let intersection = new Set(firstZone.targetIds);

    for (let i = 1; i < zoneNames.length; i++) {
      const zone = this.zones.get(zoneNames[i]);
      if (!zone) {
        throw new Error(`Zone ${zoneNames[i]} not found`);
      }
      intersection = new Set(
        [...intersection].filter((id) => zone.targetIds.includes(id)),
      );
    }

    return Array.from(intersection);
  }

  /**
   * Get all unique targets across multiple zones (union)
   */
  getUnion(zoneNames: string[]): string[] {
    const union = new Set<string>();

    for (const zoneName of zoneNames) {
      const zone = this.zones.get(zoneName);
      if (!zone) {
        throw new Error(`Zone ${zoneName} not found`);
      }
      for (const targetId of zone.targetIds) {
        union.add(targetId);
      }
    }

    return Array.from(union);
  }
}
