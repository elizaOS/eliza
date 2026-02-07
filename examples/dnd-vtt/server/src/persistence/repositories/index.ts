/**
 * Repository Index
 * Central exports for all database repositories
 */

export { campaignRepository, CampaignRepository } from './campaign-repository';
export type { CreateCampaignInput, UpdateCampaignInput } from './campaign-repository';

export { characterRepository, CharacterRepository } from './character-repository';
export type { CreateCharacterInput, UpdateCharacterInput, CreateMemoryInput } from './character-repository';

export { locationRepository, LocationRepository } from './location-repository';
export type { CreateLocationInput, CreateBattleMapInput, CreateNPCInput } from './location-repository';

export { worldRepository, WorldRepository } from './world-repository';
export type { CreateWorldEventInput, CreateQuestInput, CreateItemInput, CreateCombatLogInput } from './world-repository';
