import { pgTable, uuid, text, jsonb, integer, timestamp, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Stores multi-dimensional trust profiles for entities.
 */
export const trustProfiles = pgTable('trust_profiles', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  entityId: uuid('entity_id').notNull(),
  evaluatorId: uuid('evaluator_id').notNull(),
  overallTrust: integer('overall_trust').notNull(),
  confidence: integer('confidence').notNull(),
  interactionCount: integer('interaction_count').default(0),
  trendDirection: text('trend_direction').notNull(),
  trendChangeRate: integer('trend_change_rate').default(0),
  dimensions: jsonb('dimensions').notNull(),
  lastCalculated: timestamp('last_calculated').defaultNow().notNull(),
});

/**
 * Stores individual pieces of evidence that contribute to a trust profile.
 */
export const trustEvidence = pgTable('trust_evidence', {
    id: uuid('id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
    targetEntityId: uuid('target_entity_id').notNull(),
    sourceEntityId: uuid('source_entity_id').notNull(),
    evaluatorId: uuid('evaluator_id').notNull(),
    type: text('type').notNull(),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
    impact: integer('impact').notNull(),
    weight: integer('weight').default(1),
    description: text('description'),
    verified: boolean('verified').default(false),
    context: jsonb('context'),
});


/**
 * Stores contextual role assignments for entities.
 */
export const contextualRoles = pgTable('contextual_roles', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  entityId: uuid('entity_id').notNull(),
  role: text('role').notNull(),
  assignedBy: uuid('assigned_by').notNull(),
  context: jsonb('context'), // Can store worldId, roomId, platform, etc.
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Stores permission delegations between entities.
 */
export const permissionDelegations = pgTable('permission_delegations', {
    id: uuid('id')
        .primaryKey()
        .default(sql`gen_random_uuid()`),
    delegatorId: uuid('delegator_id').notNull(),
    delegateeId: uuid('delegatee_id').notNull(),
    permissions: jsonb('permissions').notNull(), // Array of Permission objects
    context: jsonb('context'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Stores behavioral profiles for entities to detect anomalies and multi-account abuse.
 */
export const behavioralProfiles = pgTable('behavioral_profiles', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  entityId: uuid('entity_id').notNull().unique(),
  typingSpeed: integer('typing_speed').default(0), // words per minute
  vocabularyComplexity: integer('vocabulary_complexity').default(0), // 0-100
  messageLengthMean: integer('message_length_mean').default(0),
  messageLengthStdDev: integer('message_length_std_dev').default(0),
  activeHours: jsonb('active_hours').default('[]'), // JSON array of 24 hour counts
  commonPhrases: jsonb('common_phrases').default('[]'), // JSON array of common phrases
  interactionPatterns: jsonb('interaction_patterns').default('{}'), // JSON map of interaction types
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Logs significant security incidents for auditing and threat analysis.
 */
export const securityIncidents = pgTable('security_incidents', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  entityId: uuid('entity_id').notNull(),
  type: text('type').notNull(), // e.g., 'prompt_injection', 'phishing_attempt'
  severity: text('severity').notNull(), // 'low', 'medium', 'high', 'critical'
  context: jsonb('context'),
  details: jsonb('details'),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  handled: text('handled').default('pending'), // 'pending', 'resolved', 'ignored'
});

/**
 * Stores hypothesized links between entity identities on different platforms.
 */
export const identityLinks = pgTable('identity_links', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  entityIdA: uuid('entity_id_a').notNull(),
  entityIdB: uuid('entity_id_b').notNull(),
  confidence: integer('confidence').notNull(), // 0-100
  evidence: jsonb('evidence').default('[]'), // Array of evidence descriptions
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Securely stores whistleblower reports.
 */
export const whistleblowerReports = pgTable('whistleblower_reports', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  reportedEntityId: uuid('reported_entity_id').notNull(),
  evidence: jsonb('evidence').notNull(),
  status: text('status').default('pending'), // 'pending', 'investigating', 'resolved'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Reporter ID is intentionally omitted to ensure anonymity
});
