import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export { agentTable } from './agent';
export { cacheTable } from './cache';
export { componentTable } from './component';
export { embeddingTable, DIMENSION_MAP, type EmbeddingDimensionColumn } from './embedding';
export { entityTable } from './entity';
export { logTable } from './log';
export { memoryTable } from './memory';
export { participantTable } from './participant';
export { relationshipTable } from './relationship';
export { roomTable } from './room';
export { worldTable } from './world';
export { taskTable } from './tasks';

// Central database tables
export { messageServerTable } from './messageServer';
export { channelTable } from './channel';
export { messageTable } from './message';
export { channelParticipantsTable } from './channelParticipant';
export { serverAgentsTable } from './serverAgent';
export { numberTimestamp, stringJsonb } from './types';
export { SchemaFactory, setDatabaseType, getSchemaFactory, type DatabaseType } from './factory';
