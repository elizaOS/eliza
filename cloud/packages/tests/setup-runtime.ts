/**
 * Global Test Setup for Runtime Tests
 *
 * Uses the local database (same as running server).
 * Creates test fixtures, runs tests, cleans up after.
 */

import { getConnectionString, verifyConnection } from "./infrastructure/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "./infrastructure/test-data-factory";

// Global test state
let globalTestData: TestDataSet | null = null;
let isSetup = false;

/**
 * Get the global test data set
 */
export function getTestData(): TestDataSet {
  if (!globalTestData) {
    throw new Error("Test data not initialized. Call setupTestEnvironment() first.");
  }
  return globalTestData;
}

/**
 * Get the database connection string
 */
export function getDatabaseUrl(): string {
  return getConnectionString();
}

/**
 * Check if environment is already set up
 */
export function isEnvironmentReady(): boolean {
  return isSetup;
}

export interface SetupOptions {
  organizationName?: string;
  userName?: string;
  userEmail?: string;
  creditBalance?: number;
  includeCharacter?: boolean;
  characterName?: string;
  characterData?: Record<string, unknown>;
  characterSettings?: Record<string, unknown>;
}

/**
 * Setup the test environment
 * Call this in beforeAll() of your test suite
 */
export async function setupTestEnvironment(options: SetupOptions = {}): Promise<void> {
  if (isSetup) {
    console.log("[Setup] Environment already initialized, skipping...");
    return;
  }

  console.log("\n" + "=".repeat(60));
  console.log("🚀 SETTING UP TEST ENVIRONMENT (Local DB)");
  console.log("=".repeat(60));

  // Step 1: Verify database connection
  console.log("\n📦 Step 1: Verifying database connection...");
  const connectionString = getConnectionString();
  const connected = await verifyConnection();
  if (!connected) {
    throw new Error(
      "Cannot connect to database. Make sure DATABASE_URL is set and server is running.",
    );
  }
  console.log(`✅ Database connected`);

  // Step 2: Create test data (org, user, api key)
  console.log("\n👤 Step 2: Creating test data...");
  globalTestData = await createTestDataSet(connectionString, {
    organizationName: options.organizationName || "Test Organization",
    userName: options.userName || "Test User",
    userEmail: options.userEmail || `test-${Date.now()}@eliza.test`,
    creditBalance: options.creditBalance ?? 1000.0, // High credits for testing
    includeCharacter: options.includeCharacter,
    characterName: options.characterName,
    characterData: options.characterData,
    characterSettings: options.characterSettings,
  });
  console.log("✅ Test data created");

  isSetup = true;

  console.log("\n" + "=".repeat(60));
  console.log("✅ TEST ENVIRONMENT READY");
  console.log(`   API Key: ${globalTestData.apiKey.keyPrefix}...`);
  console.log(`   Org Credits: $${globalTestData.organization.creditBalance}`);
  console.log("=".repeat(60) + "\n");
}

/**
 * Cleanup the test environment
 * Call this in afterAll() of your test suite
 */
export async function cleanupTestEnvironment(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("🧹 CLEANING UP TEST ENVIRONMENT");
  console.log("=".repeat(60));

  // Clean up test data
  if (globalTestData) {
    try {
      const connectionString = getConnectionString();
      await cleanupTestData(connectionString, globalTestData.organization.id);
      console.log("✅ Test data cleaned up");
    } catch (error) {
      console.warn(`⚠️ Test data cleanup warning: ${error}`);
    }
  }

  // Reset state
  globalTestData = null;
  isSetup = false;

  console.log("=".repeat(60) + "\n");
}

// Re-export for convenience
export {
  getConnectionString,
  verifyConnection,
} from "./infrastructure/local-database";
export type { TestDataSet } from "./infrastructure/test-data-factory";
