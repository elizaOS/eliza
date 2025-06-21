import { getSchemaFactory, createLazyTableProxy } from './factory';

/**
 * Lazy-loaded agent table definition.
 * This function returns the agent table schema when called,
 * ensuring the database type is set before schema creation.
 */
function createAgentTable() {
  const factory = getSchemaFactory();

  const tableColumns = {
    id: (() => {
      const defaultUuid = factory.defaultRandomUuid();
      const column = factory.uuid('id').primaryKey();
      return defaultUuid ? column.default(defaultUuid) : column;
    })(),
    createdAt: factory.timestamp('created_at').notNull().default(factory.defaultTimestamp()),
    updatedAt: factory.timestamp('updated_at').notNull().default(factory.defaultTimestamp()),
    name: factory.text('name').notNull(),
    username: factory.text('username'),
    bio: factory.text('bio').notNull(),
    system: factory.text('system').notNull(),
    lore: factory.json('lore').$type<string[]>().default([]),
    topics: factory.json('topics').$type<string[]>().default([]),
    interests: factory.json('interests').$type<string[]>().default([]),
    adjectives: factory.json('adjectives').$type<string[]>().default([]),
    knowledge: factory.json('knowledge').$type<string[]>().default([]),
    knowledgeCutoff: factory.text('knowledge_cutoff'),
    messageExamples: factory.json('message_examples').$type<any[]>().default([]),
    postExamples: factory.json('post_examples').$type<string[]>().default([]),
    style: factory
      .json('style')
      .$type<{ all?: string[]; chat?: string[]; post?: string[] }>()
      .default({}),
    styleAll: factory.json('style_all').$type<string[]>().default([]),
    styleChat: factory.json('style_chat').$type<string[]>().default([]),
    stylePost: factory.json('style_post').$type<string[]>().default([]),
    people: factory.json('people').$type<string[]>().default([]),
    modelProvider: factory.text('model_provider').notNull(),
    modelEndpointOverride: factory.text('model_endpoint_override'),
    enabled: factory.boolean('enabled').default(true),
    status: factory.text('status'),
    settings: factory
      .json('settings')
      .$type<{
        secrets?: Record<string, string>;
        intiface?: boolean;
        imageSettings?: {
          steps?: number;
          width?: number;
          height?: number;
          negativePrompt?: string;
          numIterations?: number;
          guidanceScale?: number;
          seed?: number;
          modelId?: string;
          jobId?: string;
          count?: number;
          stylePreset?: string;
        };
        voice?: {
          model?: string;
          url?: string;
          elevenlabsVoiceId?: string;
        };
        model?: string;
        embeddingModel?: string;
      }>()
      .default({}),
    plugins: factory.json('plugins').$type<string[]>().default([]),
    clients: factory.json('clients').$type<string[]>().default([]),
    clientConfig: factory
      .json('client_config')
      .$type<{
        discord?: {
          shouldIgnoreBotMessages?: boolean;
          shouldIgnoreDirectMessages?: boolean;
          shouldRespondOnlyToMentions?: boolean;
          shouldRespondOnlyInAllowedChannels?: boolean;
          allowedChannels?: string[];
          allowedRoles?: string[];
          blockedUsers?: string[];
          shouldEnableMessageTraversal?: boolean;
          isPartOfTeam?: boolean;
          teamAgentIds?: string[];
          teamLeaderId?: string;
          teamMemberInterestKeywords?: string[];
        };
        telegram?: {
          shouldIgnoreBotMessages?: boolean;
          shouldIgnoreDirectMessages?: boolean;
          shouldRespondOnlyToMentions?: boolean;
          shouldRespondOnlyInAllowedChannels?: boolean;
          allowedChannels?: string[];
          blockedUsers?: string[];
          shouldEnableMessageTraversal?: boolean;
          isPartOfTeam?: boolean;
          teamAgentIds?: string[];
          teamLeaderId?: string;
          teamMemberInterestKeywords?: string[];
        };
        twitter?: {
          shouldIgnoreBotMessages?: boolean;
          shouldRespondOnlyToMentions?: boolean;
          blockedUsers?: string[];
          shouldEnableMessageTraversal?: boolean;
          isPartOfTeam?: boolean;
          teamAgentIds?: string[];
          teamLeaderId?: string;
          teamMemberInterestKeywords?: string[];
        };
      }>()
      .default({}),
    enableRag: factory.boolean('enable_rag').default(false),
    ragTargetCount: factory.integer('rag_target_count').default(5),
    ragTopK: factory.integer('rag_top_k').default(50),
    ragTopP: factory.text('rag_top_p').default('0.9'),
    ragTemperature: factory.text('rag_temperature').default('0.7'),
    ragFrequencyPenalty: factory.text('rag_frequency_penalty').default('0.0'),
    ragPresencePenalty: factory.text('rag_presence_penalty').default('0.0'),
  };

  return factory.table('agents', tableColumns, (table) => ({
    nameIdx: factory.index('agents_name_idx').on(table.name),
  }));
}

/**
 * Represents a table for storing agent data.
 * Uses lazy initialization to ensure proper database type configuration.
 */
export const agentTable = createLazyTableProxy(createAgentTable);
