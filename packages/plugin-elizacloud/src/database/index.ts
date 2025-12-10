/**
 * ElizaOS Cloud Database Module
 *
 * Provides managed PostgreSQL database access via ElizaOS Cloud.
 * When using ElizaOS Cloud, users don't need to set up their own database.
 * The cloud provisions and manages the database automatically.
 *
 * For direct database connections (e.g., cloud platform itself), use createDirectDatabaseAdapter.
 */

export { CloudDatabaseAdapter, createCloudDatabaseAdapter } from "./adapter";
export { createDirectDatabaseAdapter } from "./direct-adapter";
export type { CloudDatabaseConfig } from "./types";
