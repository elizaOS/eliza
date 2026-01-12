import type { IStorage } from "./types";

export class BrowserStorage implements IStorage {
  private prefix: string;
  private ready = false;

  constructor(prefix = "elizaos") {
    this.prefix = prefix;
  }

  async init(): Promise<void> {
    this.ready = typeof localStorage !== "undefined";
    if (!this.ready) {
      throw new Error("localStorage is not available in this environment");
    }
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  private getKey(collection: string, id: string): string {
    return `${this.prefix}:${collection}:${id}`;
  }

  private getCollectionPrefix(collection: string): string {
    return `${this.prefix}:${collection}:`;
  }

  private getAllKeysForCollection(collection: string): string[] {
    const prefix = this.getCollectionPrefix(collection);
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    try {
      const key = this.getKey(collection, id);
      const data = localStorage.getItem(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  async getAll<T>(collection: string): Promise<T[]> {
    const keys = this.getAllKeysForCollection(collection);
    const items: T[] = [];

    for (const key of keys) {
      try {
        const data = localStorage.getItem(key);
        if (data) {
          items.push(JSON.parse(data) as T);
        }
      } catch {
        // Skip invalid items
      }
    }

    return items;
  }

  async getWhere<T>(collection: string, predicate: (item: T) => boolean): Promise<T[]> {
    const all = await this.getAll<T>(collection);
    return all.filter(predicate);
  }

  async set<T>(collection: string, id: string, data: T): Promise<void> {
    const key = this.getKey(collection, id);
    localStorage.setItem(key, JSON.stringify(data));
  }

  async delete(collection: string, id: string): Promise<boolean> {
    const key = this.getKey(collection, id);
    if (localStorage.getItem(key) === null) {
      return false;
    }
    localStorage.removeItem(key);
    return true;
  }

  async deleteMany(collection: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.delete(collection, id);
    }
  }

  async deleteWhere<T = Record<string, unknown>>(
    collection: string,
    predicate: (item: T) => boolean
  ): Promise<void> {
    const keys = this.getAllKeysForCollection(collection);

    for (const key of keys) {
      try {
        const data = localStorage.getItem(key);
        if (data) {
          const item = JSON.parse(data) as T;
          if (predicate(item)) {
            localStorage.removeItem(key);
          }
        }
      } catch {
        // Skip invalid items
      }
    }
  }

  async count<T = Record<string, unknown>>(
    collection: string,
    predicate?: (item: T) => boolean
  ): Promise<number> {
    if (!predicate) {
      return this.getAllKeysForCollection(collection).length;
    }

    const items = await this.getAll<T>(collection);
    return items.filter(predicate).length;
  }

  async saveRaw(filename: string, data: string): Promise<void> {
    const key = `${this.prefix}:_raw:${filename}`;
    localStorage.setItem(key, data);
  }

  async loadRaw(filename: string): Promise<string | null> {
    const key = `${this.prefix}:_raw:${filename}`;
    return localStorage.getItem(key);
  }
}
