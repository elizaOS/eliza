/**
 * Storage Provider Interface
 *
 * The main interface that combines all storage ports.
 * Implementations can be PostgreSQL, JSON files, or in-memory.
 */

import type { ActorPort, OrganizationPort } from './actors';
import type { AgentPort } from './agents';
import type { GamePort } from './game';
import type { MarketPort } from './markets';
import type { PostPort } from './posts';
import type { QuestionPort } from './questions';
import type { TradingPort } from './trading';
import type { UserPort } from './users';

export type StorageMode = 'postgres' | 'json' | 'memory';

export interface StorageProviderConfig {
  mode: StorageMode;
  /** Base path for JSON storage (required for json mode) */
  jsonBasePath?: string;
  /** Whether to persist in-memory changes to disk (for memory mode) */
  persistOnChange?: boolean;
  /** Seed data for initialization */
  seedData?: {
    actors?: boolean;
    organizations?: boolean;
  };
}

/**
 * Complete storage provider interface.
 *
 * This is the main abstraction that allows the engine to work with
 * different storage backends (Postgres, JSON files, in-memory).
 */
export interface IStorageProvider {
  readonly mode: StorageMode;

  // Domain Ports
  readonly actors: ActorPort;
  readonly organizations: OrganizationPort;
  readonly agents: AgentPort;
  readonly game: GamePort;
  readonly markets: MarketPort;
  readonly posts: PostPort;
  readonly questions: QuestionPort;
  readonly trading: TradingPort;
  readonly users: UserPort;

  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // Health check
  isHealthy(): Promise<boolean>;

  // Transaction support (optional, not all backends support this)
  withTransaction?<T>(
    fn: (provider: IStorageProvider) => Promise<T>
  ): Promise<T>;

  // Snapshot support for JSON/memory modes
  saveSnapshot?(): Promise<void>;
  loadSnapshot?(path: string): Promise<void>;
  exportToJson?(path: string): Promise<void>;
}

/**
 * Storage context - global provider management.
 * Uses a singleton pattern to ensure consistent state across modules.
 */
declare global {
  // eslint-disable-next-line no-var
  var __feed_storage_provider__: IStorageProvider | undefined;
}

/**
 * Set the global storage provider.
 */
export function setStorageProvider(provider: IStorageProvider): void {
  globalThis.__feed_storage_provider__ = provider;
}

/**
 * Get the global storage provider.
 * Throws if not initialized.
 */
export function getStorageProvider(): IStorageProvider {
  const provider = globalThis.__feed_storage_provider__;
  if (!provider) {
    throw new Error(
      'Storage provider not initialized. Call setStorageProvider() first, or use createStorageProvider().'
    );
  }
  return provider;
}

/**
 * Check if a storage provider is set.
 */
export function hasStorageProvider(): boolean {
  return globalThis.__feed_storage_provider__ !== undefined;
}

/**
 * Clear the global storage provider (for testing).
 */
export function clearStorageProvider(): void {
  globalThis.__feed_storage_provider__ = undefined;
}

/**
 * Get a specific port from the storage provider.
 */
export function getPort<
  K extends keyof Omit<
    IStorageProvider,
    | 'mode'
    | 'initialize'
    | 'shutdown'
    | 'isHealthy'
    | 'withTransaction'
    | 'saveSnapshot'
    | 'loadSnapshot'
    | 'exportToJson'
  >,
>(key: K): IStorageProvider[K] {
  return getStorageProvider()[key];
}
