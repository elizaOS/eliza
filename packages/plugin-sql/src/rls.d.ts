import { type IDatabaseAdapter } from "@elizaos/core";
/**
 * PostgreSQL Row-Level Security (RLS) for Multi-Server and Entity Isolation
 *
 * This module provides two layers of database-level security:
 *
 * 1. **Server RLS** - Multi-server isolation
 *    - Isolates data between different elizaOS server instances
 *    - Uses `server_id` column added dynamically to all tables
 *    - Server context set via PostgreSQL `application_name` connection parameter
 *    - Prevents data leakage between different deployments/environments
 *
 * 2. **Entity RLS** - User/agent-level privacy isolation
 *    - Isolates data between different users (Clients (plugins/API) users)
 *    - Uses `entity_id`, `author_id`, or joins via `participants` table
 *    - Entity context set via `app.entity_id` transaction-local variable
 *    - Provides DM privacy and multi-user isolation within a server
 *
 * CRITICAL SECURITY REQUIREMENTS:
 * - RLS policies DO NOT apply to PostgreSQL superuser accounts
 * - Use a REGULAR (non-superuser) database user
 * - Grant only necessary permissions (CREATE, SELECT, INSERT, UPDATE, DELETE)
 * - NEVER use the 'postgres' superuser or any superuser account
 * - Superusers bypass ALL RLS policies by design, defeating the isolation mechanism
 *
 * ARCHITECTURE:
 * - Server RLS: Uses PostgreSQL `application_name` (set at connection pool level)
 * - Entity RLS: Uses `SET LOCAL app.entity_id` (set per transaction)
 * - Policies use FORCE ROW LEVEL SECURITY to enforce even for table owners
 * - Automatic index creation for performance (`server_id`, `entity_id`, `room_id`)
 *
 * @module rls
 */
/**
 * Install PostgreSQL functions required for Server RLS and Entity RLS
 *
 * This function creates all necessary PostgreSQL stored procedures for both
 * Server RLS (multi-server isolation) and Entity RLS (user privacy isolation).
 *
 * **Server RLS Functions Created:**
 * - `current_server_id()` - Returns server UUID from `application_name`
 * - `add_server_isolation(schema, table)` - Adds Server RLS to a single table
 * - `apply_rls_to_all_tables()` - Applies Server RLS to all eligible tables
 *
 * **Entity RLS Functions Created:**
 * - `current_entity_id()` - Returns entity UUID from `app.entity_id` session variable
 * - `add_entity_isolation(schema, table)` - Adds Entity RLS to a single table
 * - `apply_entity_rls_to_all_tables()` - Applies Entity RLS to all eligible tables
 *
 * **Security Model:**
 * - Server RLS: Isolation between different elizaOS instances (environments/deployments)
 * - Entity RLS: Isolation between different users within a server instance
 * - Both layers stack - a user can only see data from their server AND their accessible entities
 *
 * **Important Notes:**
 * - Must be called before `applyRLSToNewTables()` or `applyEntityRLSToAllTables()`
 * - Creates `servers` table if it doesn't exist
 * - Automatically calls `installEntityRLS()` to set up both layers
 * - Uses `%I` identifier quoting in format() to prevent SQL injection
 * - Policies use FORCE RLS to enforce even for table owners
 *
 * @param adapter - Database adapter with access to the Drizzle ORM instance
 * @returns Promise that resolves when all RLS functions are installed
 * @throws {Error} If database connection fails or SQL execution fails
 *
 * @example
 * ```typescript
 * // Install RLS functions on server startup
 * await installRLSFunctions(database);
 * await getOrCreateRlsServer(database, serverId);
 * await setServerContext(database, serverId);
 * await applyRLSToNewTables(database);
 * ```
 */
export declare function installRLSFunctions(
  adapter: IDatabaseAdapter,
): Promise<void>;
/**
 * Get or create RLS server using Drizzle ORM
 */
export declare function getOrCreateRlsServer(
  adapter: IDatabaseAdapter,
  serverId: string,
): Promise<string>;
/**
 * Set RLS context on PostgreSQL connection pool
 * This function validates that the server exists and has correct UUID format
 */
export declare function setServerContext(
  adapter: IDatabaseAdapter,
  serverId: string,
): Promise<void>;
/**
 * Assign agent to server using Drizzle ORM
 */
export declare function assignAgentToServer(
  adapter: IDatabaseAdapter,
  agentId: string,
  serverId: string,
): Promise<void>;
/**
 * Apply RLS to all tables by calling PostgreSQL function
 */
export declare function applyRLSToNewTables(
  adapter: IDatabaseAdapter,
): Promise<void>;
/**
 * Disable RLS globally
 * SIMPLE APPROACH:
 * - Disables RLS for ALL server instances
 * - Keeps server_id columns and data intact
 * - Use only in development or when migrating to single-server mode
 */
export declare function uninstallRLS(adapter: IDatabaseAdapter): Promise<void>;
/**
 * Install Entity RLS functions for user privacy isolation
 *
 * This provides database-level privacy between different entities (client users: Plugins/API)
 * interacting with agents, independent of JWT authentication.
 *
 * **How Entity RLS Works:**
 * - Each database transaction sets `app.entity_id` before querying
 * - Policies filter rows based on entity ownership or participant membership
 * - Two isolation strategies:
 *   1. Direct ownership: `entity_id` or `author_id` column matches `current_entity_id()`
 *   2. Shared access: `room_id`/`channel_id` exists in `participants` table for the entity
 *
 * **Performance Considerations:**
 * - **Subquery policies** (for `room_id`/`channel_id`) run on EVERY row access
 * - Indexes are automatically created on: `entity_id`, `author_id`, `room_id`, `channel_id`
 * - The `participants` table should have an index on `(entity_id, channel_id)`
 * - For large datasets (>1M rows), consider:
 *   - Materialized views for frequently accessed entity-filtered data
 *   - Partitioning large tables by date or entity_id
 *
 * **Optimization Tips:**
 * - Direct column policies (`entity_id = current_entity_id()`) are faster than subquery policies
 * - The `participants` lookup is cached per transaction but still requires index scans
 *
 * **Tables Excluded from Entity RLS:**
 * - `servers` - Server RLS table
 * - `users` - Authentication (no entity isolation)
 * - `entity_mappings` - Cross-platform entity mapping
 * - `drizzle_migrations`, `__drizzle_migrations` - Migration tracking
 *
 * @param adapter - Database adapter with access to the Drizzle ORM instance
 * @returns Promise that resolves when Entity RLS functions are installed
 * @throws {Error} If database connection fails or SQL execution fails
 *
 * @example
 * ```typescript
 * // Called automatically by installRLSFunctions()
 * await installRLSFunctions(database);
 *
 * // Or call separately if needed
 * await installEntityRLS(database);
 * await applyEntityRLSToAllTables(database);
 * ```
 */
export declare function installEntityRLS(
  adapter: IDatabaseAdapter,
): Promise<void>;
/**
 * Apply Entity RLS policies to all eligible tables
 * Call this after installEntityRLS() to activate the policies
 */
export declare function applyEntityRLSToAllTables(
  adapter: IDatabaseAdapter,
): Promise<void>;
/**
 * Remove Entity RLS (for rollback or testing)
 * Drops entity RLS functions and policies but keeps server RLS intact
 */
export declare function uninstallEntityRLS(
  adapter: IDatabaseAdapter,
): Promise<void>;
//# sourceMappingURL=rls.d.ts.map
