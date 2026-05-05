import type { IStorage } from "./types";

export class MemoryStorage implements IStorage {
  private collections: Map<string, Map<string, unknown>> = new Map();
  private ready = false;

  async init(): Promise<void> {
    this.ready = true;
  }

  async close(): Promise<void> {
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

  async deleteWhere<T = Record<string, unknown>>(
    collection: string,
    predicate: (item: T) => boolean
  ): Promise<void> {
    const col = this.getCollection(collection);
    const toDelete: string[] = [];

    for (const [id, item] of col) {
      if (predicate(item as T)) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      col.delete(id);
    }
  }

  async count<T = Record<string, unknown>>(
    collection: string,
    predicate?: (item: T) => boolean
  ): Promise<number> {
    const col = this.getCollection(collection);

    if (!predicate) {
      return col.size;
    }

    let count = 0;
    for (const item of col.values()) {
      if (predicate(item as T)) {
        count++;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    this.collections.clear();
  }
}
