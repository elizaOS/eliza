import type {
  IAgentRuntime,
  IDatabaseAdapter,
  Plugin,
  UUID,
} from "@elizaos/core";
import {
  InMemoryDatabaseAdapter,
  type IStorage,
} from "@elizaos/plugin-inmemorydb";

type RuntimeWithDatabase = IAgentRuntime & {
  registerDatabaseAdapter?: (adapter: IDatabaseAdapter) => void;
  adapter?: IDatabaseAdapter;
  databaseAdapter?: IDatabaseAdapter;
  hasDatabaseAdapter?: () => boolean;
};

class BrowserLocalStorage implements IStorage {
  private collections = new Map<string, Map<string, unknown>>();
  private ready = false;

  constructor(private readonly key: string) {}

  async init(): Promise<void> {
    const raw = globalThis.localStorage?.getItem(this.key);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      for (const [collection, entries] of Object.entries(parsed)) {
        this.collections.set(collection, new Map(Object.entries(entries)));
      }
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    await this.flush();
    this.ready = false;
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  private getCollection(collection: string): Map<string, unknown> {
    let current = this.collections.get(collection);
    if (!current) {
      current = new Map();
      this.collections.set(collection, current);
    }
    return current;
  }

  private async flush(): Promise<void> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [collection, entries] of this.collections) {
      out[collection] = Object.fromEntries(entries);
    }
    globalThis.localStorage?.setItem(this.key, JSON.stringify(out));
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const item = this.getCollection(collection).get(id);
    return item === undefined ? null : (item as T);
  }

  async getAll<T>(collection: string): Promise<T[]> {
    return Array.from(this.getCollection(collection).values()) as T[];
  }

  async getWhere<T>(
    collection: string,
    predicate: (item: T) => boolean,
  ): Promise<T[]> {
    return (await this.getAll<T>(collection)).filter(predicate);
  }

  async set<T>(collection: string, id: string, data: T): Promise<void> {
    this.getCollection(collection).set(id, data);
    await this.flush();
  }

  async delete(collection: string, id: string): Promise<boolean> {
    const deleted = this.getCollection(collection).delete(id);
    if (deleted) await this.flush();
    return deleted;
  }

  async deleteMany(collection: string, ids: string[]): Promise<void> {
    const current = this.getCollection(collection);
    for (const id of ids) current.delete(id);
    await this.flush();
  }

  async deleteWhere<T = Record<string, unknown>>(
    collection: string,
    predicate: (item: T) => boolean,
  ): Promise<void> {
    const current = this.getCollection(collection);
    for (const [id, item] of current) {
      if (predicate(item as T)) current.delete(id);
    }
    await this.flush();
  }

  async count<T = Record<string, unknown>>(
    collection: string,
    predicate?: (item: T) => boolean,
  ): Promise<number> {
    const current = this.getCollection(collection);
    if (!predicate) return current.size;
    let total = 0;
    for (const item of current.values()) {
      if (predicate(item as T)) total++;
    }
    return total;
  }

  async clear(): Promise<void> {
    this.collections.clear();
    await this.flush();
  }
}

export function createDatabaseAdapter(agentId: UUID): InMemoryDatabaseAdapter {
  return new InMemoryDatabaseAdapter(
    new BrowserLocalStorage(`elizaos:localdb:${agentId}`),
    agentId,
  );
}

export const plugin: Plugin = {
  name: "@elizaos/plugin-localdb",
  description: "Browser localStorage database storage for elizaOS examples.",

  async init(
    _config: Record<string, string>,
    runtime: IAgentRuntime,
  ): Promise<void> {
    const r = runtime as RuntimeWithDatabase;
    const hasAdapter =
      r.adapter !== undefined ||
      r.databaseAdapter !== undefined ||
      (r.hasDatabaseAdapter?.() ?? false);

    if (hasAdapter) return;

    const adapter = createDatabaseAdapter(runtime.agentId);
    await adapter.initialize();
    r.registerDatabaseAdapter?.(adapter);
  },
};

export default plugin;
