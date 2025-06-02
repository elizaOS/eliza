import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Table exports
export { agentTable } from './agent';
export { cacheTable } from './cache';
export { channelTable } from './channel';
export { channelParticipantsTable } from './channelParticipant';
export { componentTable } from './component';
export { embeddingTable, DIMENSION_MAP, type EmbeddingDimensionColumn } from './embedding';
export { entityTable } from './entity';
export { logTable } from './log';
export { memoryTable } from './memory';
export { messageTable } from './message';
export { messageServerTable } from './messageServer';
export { participantTable } from './participant';
export { relationshipTable } from './relationship';
export { roomTable } from './room';
export { serverAgentsTable } from './serverAgent';
export { taskTable } from './tasks';
export { worldTable } from './world';

// Type and utility exports
export { setDatabaseType } from './types';
