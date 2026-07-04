/**
 * In-process CacheRedisClient with no external backend, used for tests and
 * single-process local runs. Holds string values and lists in Maps with manual
 * TTL expiry checked on read.
 */

import type { CacheRedisClient } from "./types";

export class MemoryCacheAdapter implements CacheRedisClient {
  readonly backend = "memory";
  private readonly values = new Map<string, { value: string; expireAt: number | null }>();
  private readonly lists = new Map<string, { values: string[]; expireAt: number | null }>();

  private now(): number {
    return Date.now();
  }

  private getValue(key: string): string | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expireAt !== null && entry.expireAt <= this.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  private getList(key: string): string[] | null {
    const entry = this.lists.get(key);
    if (!entry) return null;
    if (entry.expireAt !== null && entry.expireAt <= this.now()) {
      this.lists.delete(key);
      return null;
    }
    return entry.values;
  }

  private setValue(key: string, value: string, ttlMs?: number): void {
    this.values.set(key, {
      value,
      expireAt: ttlMs === undefined ? null : this.now() + ttlMs,
    });
    this.lists.delete(key);
  }

  private setExpiry(key: string, ttlMs: number): number {
    const expireAt = this.now() + ttlMs;
    const valueEntry = this.values.get(key);
    if (valueEntry && this.getValue(key) !== null) {
      valueEntry.expireAt = expireAt;
      return 1;
    }

    const listEntry = this.lists.get(key);
    if (listEntry && this.getList(key) !== null) {
      listEntry.expireAt = expireAt;
      return 1;
    }

    return 0;
  }

  private deleteExpired(): void {
    for (const key of this.values.keys()) {
      this.getValue(key);
    }
    for (const key of this.lists.keys()) {
      this.getList(key);
    }
  }

  private patternToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  }

  async get(key: string): Promise<string | null> {
    return this.getValue(key);
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<unknown> {
    this.setValue(key, value, ttlSeconds * 1000);
    return "OK";
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; px?: number },
  ): Promise<string | null> {
    if (options?.nx && this.getValue(key) !== null) {
      return null;
    }
    this.setValue(key, value, options?.px);
    return "OK";
  }

  async incr(key: string): Promise<number> {
    const next = Number.parseInt(this.getValue(key) ?? "0", 10) + 1;
    this.setValue(key, String(next));
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<unknown> {
    return this.setExpiry(key, ttlSeconds * 1000);
  }

  async pexpire(key: string, ttlMs: number): Promise<unknown> {
    return this.setExpiry(key, ttlMs);
  }

  async pttl(key: string): Promise<number | null> {
    const valueEntry = this.values.get(key);
    if (valueEntry && this.getValue(key) !== null) {
      return valueEntry.expireAt === null ? -1 : Math.max(valueEntry.expireAt - this.now(), 0);
    }

    const listEntry = this.lists.get(key);
    if (listEntry && this.getList(key) !== null) {
      return listEntry.expireAt === null ? -1 : Math.max(listEntry.expireAt - this.now(), 0);
    }

    return -2;
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.getValue(key);
    this.values.delete(key);
    return value;
  }

  async del(...keys: string[]): Promise<unknown> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
      if (this.lists.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]> {
    this.deleteExpired();
    const pattern = this.patternToRegExp(options.match);
    const keys = [...new Set([...this.values.keys(), ...this.lists.keys()])]
      .filter((key) => pattern.test(key))
      .sort();
    // Real pagination uses a key-based opaque cursor ("mem:<lastKey>"): return
    // the next `count` keys that sort strictly after the cursor key. This is
    // stable under deletion of already-returned keys (the delPattern case), where
    // an offset cursor would skip keys as the set shrinks. The token is
    // deliberately non-numeric so callers must treat it like Redis/KV cursors.
    const after = cursor === "0" || cursor === 0 ? "" : String(cursor).slice("mem:".length);
    const startIdx = after === "" ? 0 : keys.findIndex((key) => key > after);
    const begin = startIdx < 0 ? keys.length : startIdx;
    const page = keys.slice(begin, begin + options.count);
    const next = page.length === options.count ? `mem:${page[page.length - 1]}` : "0";
    return [next, page];
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.getValue(key));
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const existing = this.getList(key) ?? [];
    const entry = this.lists.get(key) ?? { values: existing, expireAt: null };
    entry.values.unshift(...values);
    this.lists.set(key, entry);
    this.values.delete(key);
    return entry.values.length;
  }

  async rpop(key: string): Promise<string | null> {
    const list = this.getList(key);
    return list?.pop() ?? null;
  }

  async llen(key: string): Promise<number> {
    return this.getList(key)?.length ?? 0;
  }
}
