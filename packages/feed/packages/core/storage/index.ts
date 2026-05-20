/**
 * Feed Storage Abstraction Layer
 *
 * Provides database-agnostic storage interfaces with multiple backend support:
 * - PostgreSQL (production)
 * - JSON files (simulation, training, debugging)
 * - In-memory (testing, benchmarking)
 *
 * Usage:
 * ```typescript
 * import { createStorageProvider, getStorageProvider } from '@feed/core/storage';
 *
 * // Initialize with JSON mode for simulation
 * const provider = await createStorageProvider({ mode: 'json', jsonBasePath: './simulation-data' });
 *
 * // Or use postgres mode for production
 * const provider = await createStorageProvider({ mode: 'postgres' });
 *
 * // Access through global context
 * const posts = await getStorageProvider().posts.getRecentPosts();
 * ```
 */

// Adapters
export * from "./adapters";
// Factory functions
export * from "./factory";
// Ports (interfaces)
export * from "./ports";
// Types
export * from "./types";
