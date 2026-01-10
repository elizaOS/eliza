/**
 * Pure in-memory storage implementation
 * 
 * All data is ephemeral and lost on process restart or close()
 */

import type { IStorage } from "./types";

/**
 * In-memory storage using Map data structures
 * Completely ephemeral - no persistence whatsoever
 */
export class MemoryStorage implements IStorage {
  private collections: Map<string, Map<string, unknown>> = new Map();
  private ready = false;

  async init(): Promise<void> {
    this.ready = true;
  }

  async close(): Promise<void> {
    // Clear all data on close - ephemeral storage
    this.collections.clear();
    this.ready = false;
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  private getCollection(collection: string): Map<string, unknown> {
    let col = this.collections.get(collection);
    if (!col) {
      col = new Map();
      this.collections.set(collection, col);
    }
    return col;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const col = this.getCollection(collection);
    const item = col.get(id);
    return item !== undefined ? (item as T) : null;
  }

  async getAll<T>(collection: string): Promise<T[]> {
    const col = this.getCollection(collection);
    return Array.from(col.values()) as T[];
  }

  async getWhere<T>(collection: string, predicate: (item: T) => boolean): Promise<T[]> {
    const all = await this.getAll<T>(collection);
    return all.filter(predicate);
  }

  async set<T>(collection: string, id: string, data: T): Promise<void> {
    const col = this.getCollection(collection);
    col.set(id, data);
  }

  async delete(collection: string, id: string): Promise<boolean> {
    const col = this.getCollection(collection);
    return col.delete(id);
  }

  async deleteMany(collection: string, ids: string[]): Promise<void> {
    const col = this.getCollection(collection);
    for (const id of ids) {
      col.delete(id);
    }
  }

  async deleteWhere(collection: string, predicate: (item: Record<string, unknown>) => boolean): Promise<void> {
    const col = this.getCollection(collection);
    const toDelete: string[] = [];
    
    for (const [id, item] of col) {
      if (predicate(item as Record<string, unknown>)) {
        toDelete.push(id);
      }
    }
    
    for (const id of toDelete) {
      col.delete(id);
    }
  }

  async count(collection: string, predicate?: (item: Record<string, unknown>) => boolean): Promise<number> {
    const col = this.getCollection(collection);
    
    if (!predicate) {
      return col.size;
    }
    
    let count = 0;
    for (const item of col.values()) {
      if (predicate(item as Record<string, unknown>)) {
        count++;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    this.collections.clear();
  }
}

