/**
 * Database Client with Multi-Region Support
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                    DATABASE ROUTING STRATEGY                         │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │                                                                      │
 * │   Vercel Serverless Function                                        │
 * │              │                                                       │
 * │              ▼                                                       │
 * │   ┌─────────────────────┐                                           │
 * │   │  Detect Region      │ ← VERCEL_REGION env var                   │
 * │   │  (iad1, cdg1, etc)  │                                           │
 * │   └─────────┬───────────┘                                           │
 * │             │                                                        │
 * │     ┌───────┴───────────────────────────┐                           │
 * │     ▼                                   ▼                           │
 * │  ┌──────────────┐              ┌──────────────┐                     │
 * │  │   EU READ    │              │  NA PRIMARY  │                     │
 * │  │   Replica    │              │ (Read/Write) │                     │
 * │  └──────────────┘              └──────────────┘                     │
 * │        │                              │                             │
 * │        │  (Logical Replication)       │                             │
 * │        └──────────────────────────────┘                             │
 * │                                                                      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Multi-Region Setup:
 * - NA (North America): Primary database (read/write)
 * - EU (Europe): Logical replication read-only replica (pub/sub from NA)
 * - Writes ALWAYS go to NA primary regardless of request region
 * - EU reads go to EU replica for low latency
 * - NA/APAC reads go to NA primary
 *
 * Environment Variables:
 * - DATABASE_URL           : Primary database in NA (required) - handles all writes and NA reads
 * - DATABASE_URL_EU_READ   : EU region read replica (optional, for low-latency EU reads)
 *
 * Note: DATABASE_URL_EU (write) should NOT be set as EU is read-only.
 *
 * Vercel Regions:
 * - iad1 (Washington DC), sfo1 (San Francisco), pdx1 (Portland) → NA
 * - cdg1 (Paris), fra1 (Frankfurt), lhr1 (London), arn1 (Stockholm) → EU
 * - hnd1 (Tokyo), sin1 (Singapore), syd1 (Sydney) → APAC (falls back to NA)
 *
 * @module db/client
 */

import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { Pool as PgPool } from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import * as schema from "./schemas";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import ws from "ws";

// ============================================================================
// Types
// ============================================================================

type Database = NodePgDatabase<typeof schema> | NeonDatabase<typeof schema>;

type DatabaseRegion = "na" | "eu" | "apac";
type DatabaseRole = "read" | "write";

interface DatabaseConfig {
  url: string;
  region: DatabaseRegion;
  role: DatabaseRole;
}

interface DatabaseConnections {
  write: Database;
  read: Database;
}

interface RegionalConnections {
  na: DatabaseConnections | null;
  eu: DatabaseConnections | null;
  apac: DatabaseConnections | null;
}

// ============================================================================
// Region Detection
// ============================================================================

/**
 * Vercel region to database region mapping
 * https://vercel.com/docs/edge-network/regions
 *
 * Database routing:
 * - EU regions → EU read replica (if configured)
 * - All other regions → NA primary
 *
 * Note: APAC and other regions currently route to NA primary.
 * Add DATABASE_URL_APAC_READ if you deploy an APAC replica.
 */
const VERCEL_REGION_MAP: Record<string, DatabaseRegion> = {
  // North America
  iad1: "na", // Washington DC (US East)
  sfo1: "na", // San Francisco (US West)
  pdx1: "na", // Portland (US West)
  cle1: "na", // Cleveland (US East)

  // South America (routes to NA - closest primary)
  gru1: "na", // São Paulo
  eze1: "na", // Buenos Aires

  // Europe
  cdg1: "eu", // Paris
  fra1: "eu", // Frankfurt
  lhr1: "eu", // London
  arn1: "eu", // Stockholm
  dub1: "eu", // Dublin

  // Africa (routes to EU - closest replica)
  cpt1: "eu", // Cape Town

  // Asia Pacific (routes to NA - no APAC replica yet)
  hnd1: "apac", // Tokyo
  kix1: "apac", // Osaka
  sin1: "apac", // Singapore
  syd1: "apac", // Sydney
  mel1: "apac", // Melbourne
  hkg1: "apac", // Hong Kong
  bom1: "apac", // Mumbai
  icn1: "apac", // Seoul
};

/**
 * Detect the current database region based on Vercel environment
 */
function detectRegion(): DatabaseRegion {
  // Check VERCEL_REGION first (set by Vercel in serverless functions)
  const vercelRegion = process.env.VERCEL_REGION;
  if (vercelRegion && VERCEL_REGION_MAP[vercelRegion]) {
    return VERCEL_REGION_MAP[vercelRegion];
  }

  // Check explicit override
  const explicitRegion = process.env.DATABASE_REGION?.toLowerCase();
  if (
    explicitRegion === "eu" ||
    explicitRegion === "na" ||
    explicitRegion === "apac"
  ) {
    return explicitRegion;
  }

  // Default to NA
  return "na";
}

/**
 * Get current region (cached for performance)
 */
let _cachedRegion: DatabaseRegion | null = null;
export function getCurrentRegion(): DatabaseRegion {
  if (_cachedRegion === null) {
    _cachedRegion = detectRegion();
  }
  return _cachedRegion;
}

// ============================================================================
// Database URL Resolution
// ============================================================================

/**
 * Get the appropriate database URL for a given region and role.
 *
 * IMPORTANT: Write operations ALWAYS go to the primary NA database.
 * EU is a read-only logical replication, so writes must never be routed there.
 *
 * Read routing:
 * - EU requests → DATABASE_URL_EU_READ (if set) → DATABASE_URL (NA primary)
 * - NA/APAC requests → DATABASE_URL (NA primary)
 *
 * Write routing:
 * - ALL requests → DATABASE_URL (NA primary)
 */
function getDatabaseUrl(
  region: DatabaseRegion,
  role: DatabaseRole,
): string | null {
  // CRITICAL: Writes ALWAYS go to the primary database (NA)
  // EU is read-only via logical replication, so we must never write there
  if (role === "write") {
    return getPrimaryDatabaseUrl();
  }

  // For EU reads, use EU replica if available
  if (region === "eu") {
    const euReadUrl = process.env.DATABASE_URL_EU_READ;
    if (euReadUrl) {
      return euReadUrl;
    }
  }

  // All other reads (NA, APAC, or EU without replica) go to NA primary
  return getPrimaryDatabaseUrl();
}

/**
 * Get the primary database URL (always required)
 */
function getPrimaryDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL environment variable is not set. " +
        "Make sure you have a .env.local file with DATABASE_URL defined.",
    );
  }
  return url;
}

// ============================================================================
// Database Connection Factory
// ============================================================================

/**
 * Checks if a database URL is for Neon serverless
 */
function isNeonDatabase(url: string): boolean {
  return url.includes("neon.tech") || url.includes("neon.database");
}

/**
 * Create a database connection from a URL
 */
function createConnection(url: string): Database {
  if (isNeonDatabase(url)) {
    // Configure WebSocket for Node.js environment
    if (typeof WebSocket === "undefined") {
      neonConfig.webSocketConstructor = ws;
    }
    const pool = new NeonPool({ connectionString: url });
    return drizzleNeon(pool, { schema }) as Database;
  } else {
    const pool = new PgPool({ connectionString: url });
    return drizzleNode(pool, { schema }) as Database;
  }
}

// ============================================================================
// Connection Manager
// ============================================================================

/**
 * Singleton connection manager for all database connections
 */
class DatabaseConnectionManager {
  private connections: Map<string, Database> = new Map();
  private initialized = false;

  /**
   * Get or create a database connection
   */
  getConnection(url: string): Database {
    if (!this.connections.has(url)) {
      this.connections.set(url, createConnection(url));
    }
    return this.connections.get(url)!;
  }

  /**
   * Get write connection - ALWAYS routes to NA primary.
   * EU is read-only via logical replication.
   */
  getWriteConnection(): Database {
    // Writes always go to primary, regardless of detected region
    const url = getPrimaryDatabaseUrl();
    return this.getConnection(url);
  }

  /**
   * Get read connection for current region
   */
  getReadConnection(): Database {
    const region = getCurrentRegion();
    const url = getDatabaseUrl(region, "read") || getPrimaryDatabaseUrl();
    return this.getConnection(url);
  }

  /**
   * Get connection for specific region and role.
   * Note: Write operations are always routed to NA primary regardless of region.
   */
  getRegionalConnection(region: DatabaseRegion, role: DatabaseRole): Database {
    // For writes, always use primary regardless of requested region
    // EU is read-only via logical replication
    if (role === "write") {
      return this.getConnection(getPrimaryDatabaseUrl());
    }

    const url = getDatabaseUrl(region, role);
    return this.getConnection(url);
  }

  /**
   * Get connection info for debugging
   */
  getConnectionInfo(): {
    currentRegion: DatabaseRegion;
    vercelRegion: string | undefined;
    hasEuReadReplica: boolean;
    writesRouteTo: "na_primary";
    readsRouteToEu: boolean;
  } {
    const currentRegion = getCurrentRegion();
    const hasEuReadReplica = !!process.env.DATABASE_URL_EU_READ;
    return {
      currentRegion,
      vercelRegion: process.env.VERCEL_REGION,
      hasEuReadReplica,
      writesRouteTo: "na_primary", // Writes always go to NA primary
      readsRouteToEu: currentRegion === "eu" && hasEuReadReplica,
    };
  }
}

const connectionManager = new DatabaseConnectionManager();

// ============================================================================
// Exported Database Instances
// ============================================================================

/**
 * Primary database - Auto-routes to nearest region
 * Use this for general queries (auto-detects read vs write intent is NOT automatic)
 *
 * @deprecated Use `db.read` or `db.write` explicitly for clarity
 */
export const db = new Proxy({} as Database, {
  get: (_, prop) => {
    // Default to write connection for backwards compatibility
    const database = connectionManager.getWriteConnection();
    const value = database[prop as keyof typeof database];
    return typeof value === "function" ? value.bind(database) : value;
  },
});

/**
 * Read database - Routes to read replica in current region
 * Use for SELECT queries, reports, analytics
 *
 * @example
 * // Read from replica
 * const users = await dbRead.query.users.findMany();
 */
export const dbRead = new Proxy({} as Database, {
  get: (_, prop) => {
    const database = connectionManager.getReadConnection();
    const value = database[prop as keyof typeof database];
    return typeof value === "function" ? value.bind(database) : value;
  },
});

/**
 * Write database - Routes to primary in current region
 * Use for INSERT, UPDATE, DELETE operations
 *
 * @example
 * // Write to primary
 * await dbWrite.insert(users).values({ name: 'John' });
 */
export const dbWrite = new Proxy({} as Database, {
  get: (_, prop) => {
    const database = connectionManager.getWriteConnection();
    const value = database[prop as keyof typeof database];
    return typeof value === "function" ? value.bind(database) : value;
  },
});

// ============================================================================
// Regional Database Accessors
// ============================================================================

/**
 * EU region database connections.
 * Note: EU is a read-only replica. write operations are routed to NA primary.
 */
export const dbEU = {
  /** EU read replica for low-latency reads in Europe */
  read: new Proxy({} as Database, {
    get: (_, prop) => {
      const database = connectionManager.getRegionalConnection("eu", "read");
      const value = database[prop as keyof typeof database];
      return typeof value === "function" ? value.bind(database) : value;
    },
  }),
  /**
   * Write connection - Routes to NA primary (EU is read-only).
   * @deprecated Use dbWrite instead for clarity. EU writes go to NA primary.
   */
  write: new Proxy({} as Database, {
    get: (_, prop) => {
      // EU is read-only, writes always go to NA primary
      const database = connectionManager.getWriteConnection();
      const value = database[prop as keyof typeof database];
      return typeof value === "function" ? value.bind(database) : value;
    },
  }),
};

/**
 * NA region database connections
 */
export const dbNA = {
  read: new Proxy({} as Database, {
    get: (_, prop) => {
      const database = connectionManager.getRegionalConnection("na", "read");
      const value = database[prop as keyof typeof database];
      return typeof value === "function" ? value.bind(database) : value;
    },
  }),
  write: new Proxy({} as Database, {
    get: (_, prop) => {
      const database = connectionManager.getRegionalConnection("na", "write");
      const value = database[prop as keyof typeof database];
      return typeof value === "function" ? value.bind(database) : value;
    },
  }),
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get connection info for debugging/monitoring
 */
export function getDbConnectionInfo() {
  return connectionManager.getConnectionInfo();
}

/**
 * Execute a read query (uses read replica)
 */
export async function withReadDb<T>(
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return fn(connectionManager.getReadConnection());
}

/**
 * Execute a write query (uses primary)
 */
export async function withWriteDb<T>(
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return fn(connectionManager.getWriteConnection());
}

/**
 * Execute with explicit region selection
 */
export async function withRegionalDb<T>(
  region: DatabaseRegion,
  role: DatabaseRole,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return fn(connectionManager.getRegionalConnection(region, role));
}

// ============================================================================
// Type Exports
// ============================================================================

export type { Database, DatabaseRegion, DatabaseRole };
