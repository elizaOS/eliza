export interface SetOptions {
  /** Expiration time in seconds */
  ex?: number;
  /** Only set if the key does not exist */
  nx?: boolean;
  /** Only set if the key already exists */
  xx?: boolean;
}

export interface KVClient {
  /**
   * Get the value of a key.
   */
  get(key: string): Promise<string | null>;

  /**
   * Set the value of a key.
   * Returns 'OK' if successful, null if condition (nx/xx) not met.
   */
  set(key: string, value: string | number, options?: SetOptions): Promise<string | null>;

  /**
   * Delete a key.
   * Returns the number of keys that were removed.
   */
  del(key: string): Promise<number>;

  /**
   * Set a timeout on key.
   * Returns 1 if the timeout was set, 0 if the key does not exist.
   */
  expire(key: string, seconds: number): Promise<number>;

  /**
   * Prepend one or multiple values to a list.
   * Returns the length of the list after the push operations.
   */
  lpush(key: string, ...elements: (string | number)[]): Promise<number>;

  /**
   * Append one or multiple values to a list.
   * Returns the length of the list after the push operations.
   */
  rpush(key: string, ...elements: (string | number)[]): Promise<number>;

  /**
   * Remove and get the first element in a list.
   */
  lpop(key: string): Promise<string | null>;

  /**
   * Remove and get the last element in a list.
   */
  rpop(key: string): Promise<string | null>;

  /**
   * Set the string value of a hash field.
   * Returns the number of fields that were added.
   */
  hset(key: string, field: string, value: string | number): Promise<number>;
  hset(key: string, obj: Record<string, string | number>): Promise<number>;

  /**
   * Get the value of a hash field.
   */
  hget(key: string, field: string): Promise<string | null>;

  /**
   * Get all the fields and values in a hash.
   */
  hgetall(key: string): Promise<Record<string, string>>;

  /**
   * Increment the integer value of a hash field by the given number.
   */
  hincrby(key: string, field: string, increment: number): Promise<number>;

  /**
   * Increment the integer value of a key by one.
   */
  incr(key: string): Promise<number>;

  /**
   * Close connection.
   */
  disconnect(): Promise<void>;
}

export type KVBackendType = 'redis' | 'memory' | 'file' | 'http';

export interface KVConfig {
  /**
   * Connection URL.
   * e.g. redis://localhost:6379, file://./data.json, memory://, https://app.mediar.ai/api/kv
   */
  url?: string;
  /**
   * Explicit backend selection if URL is generic or missing.
   */
  backend?: KVBackendType;
  /**
   * Token for cloud-hosted Redis (e.g. Upstash/Vercel KV).
   */
  token?: string;
}
