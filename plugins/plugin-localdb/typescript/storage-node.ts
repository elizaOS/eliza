import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IStorage } from "./types";

export class NodeStorage implements IStorage {
  private dataDir: string;
  private ready = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async init(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  private getCollectionDir(collection: string): string {
    return join(this.dataDir, collection);
  }

  private getFilePath(collection: string, id: string): string {
    const safeId = id.replace(/[^a-zA-Z0-9-_]/g, "_");
    return join(this.getCollectionDir(collection), `${safeId}.json`);
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const filePath = this.getFilePath(collection, id);
    try {
      if (!existsSync(filePath)) {
        return null;
      }
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  async getAll<T>(collection: string): Promise<T[]> {
    const collectionDir = this.getCollectionDir(collection);
    try {
      if (!existsSync(collectionDir)) {
        return [];
      }
      const files = await readdir(collectionDir);
      const items: T[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = await readFile(join(collectionDir, file), "utf-8");
          items.push(JSON.parse(content) as T);
        } catch {}
      }

      return items;
    } catch {
      return [];
    }
  }

  async getWhere<T>(collection: string, predicate: (item: T) => boolean): Promise<T[]> {
    const all = await this.getAll<T>(collection);
    return all.filter(predicate);
  }

  async set<T>(collection: string, id: string, data: T): Promise<void> {
    const collectionDir = this.getCollectionDir(collection);
    if (!existsSync(collectionDir)) {
      await mkdir(collectionDir, { recursive: true });
    }
    const filePath = this.getFilePath(collection, id);
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async delete(collection: string, id: string): Promise<boolean> {
    const filePath = this.getFilePath(collection, id);
    try {
      if (!existsSync(filePath)) {
        return false;
      }
      await rm(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async deleteMany(collection: string, ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.delete(collection, id)));
  }

  async deleteWhere<T = Record<string, unknown>>(
    collection: string,
    predicate: (item: T) => boolean
  ): Promise<void> {
    const collectionDir = this.getCollectionDir(collection);
    try {
      if (!existsSync(collectionDir)) {
        return;
      }
      const files = await readdir(collectionDir);

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const filePath = join(collectionDir, file);
          const content = await readFile(filePath, "utf-8");
          const item = JSON.parse(content) as T;
          if (predicate(item)) {
            await rm(filePath);
          }
        } catch {}
      }
    } catch {
      // Ignore errors
    }
  }

  async count<T = Record<string, unknown>>(
    collection: string,
    predicate?: (item: T) => boolean
  ): Promise<number> {
    if (!predicate) {
      const collectionDir = this.getCollectionDir(collection);
      try {
        if (!existsSync(collectionDir)) {
          return 0;
        }
        const files = await readdir(collectionDir);
        return files.filter((f) => f.endsWith(".json")).length;
      } catch {
        return 0;
      }
    }

    const items = await this.getAll<T>(collection);
    return items.filter(predicate).length;
  }

  async saveRaw(filename: string, data: string): Promise<void> {
    const filePath = join(this.dataDir, filename);
    const dir = join(this.dataDir, filename.split("/").slice(0, -1).join("/"));
    if (dir && dir !== this.dataDir && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(filePath, data, "utf-8");
  }

  async loadRaw(filename: string): Promise<string | null> {
    const filePath = join(this.dataDir, filename);
    try {
      if (!existsSync(filePath)) {
        return null;
      }
      return await readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }
}
