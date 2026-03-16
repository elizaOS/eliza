/**
 * Persistence Layer Index
 * Central exports for database operations
 */

// Database connection
export {
  initializeDatabase,
  getDatabase,
  getPool,
  closeDatabase,
  withTransaction,
  isDatabaseConnected,
  getDatabaseConfig,
  schema,
} from './database';
export type { DatabaseConfig } from './database';

// Repositories
export {
  campaignRepository,
  characterRepository,
  locationRepository,
  worldRepository,
  CampaignRepository,
  CharacterRepository,
  LocationRepository,
  WorldRepository,
} from './repositories';
export type {
  CreateCampaignInput,
  UpdateCampaignInput,
  CreateCharacterInput,
  UpdateCharacterInput,
  CreateMemoryInput,
  CreateLocationInput,
  CreateBattleMapInput,
  CreateNPCInput,
  CreateWorldEventInput,
  CreateQuestInput,
  CreateItemInput,
  CreateCombatLogInput,
} from './repositories';
