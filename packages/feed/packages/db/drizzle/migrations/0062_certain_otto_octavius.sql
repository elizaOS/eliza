CREATE TYPE "public"."SentryIncidentAlertOutboxStatus" AS ENUM('pending', 'processing', 'sent', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."SentryIncidentRunDecision" AS ENUM('pending', 'skip_linear', 'reuse_linear', 'create_linear', 'process_issue');--> statement-breakpoint
CREATE TYPE "public"."SentryIncidentRunStatus" AS ENUM('running', 'completed', 'failed', 'suppressed');--> statement-breakpoint
CREATE TABLE "DailyTopic" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp NOT NULL,
	"topicKey" text NOT NULL,
	"topicLabel" text NOT NULL,
	"summary" text NOT NULL,
	"sourceType" text NOT NULL,
	"sourceHeadlineIds" json NOT NULL,
	"selectionReason" text,
	"isLocked" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "DailyTopic_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "SentryIncidentAlertOutbox" (
	"id" text PRIMARY KEY NOT NULL,
	"runId" text,
	"inboxId" text NOT NULL,
	"sentryIssueKey" text NOT NULL,
	"eventType" text NOT NULL,
	"dedupeKey" text NOT NULL,
	"payload" json NOT NULL,
	"status" "SentryIncidentAlertOutboxStatus" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 8 NOT NULL,
	"nextAttemptAt" timestamp DEFAULT now() NOT NULL,
	"processingStartedAt" timestamp,
	"sentAt" timestamp,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "SentryIncidentAlertOutbox_dedupeKey_unique" UNIQUE("dedupeKey")
);
--> statement-breakpoint
CREATE TABLE "SentryIncidentDiscordThread" (
	"id" text PRIMARY KEY NOT NULL,
	"sentryIssueKey" text NOT NULL,
	"channelId" text NOT NULL,
	"rootMessageId" text NOT NULL,
	"threadId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "SentryIncidentDiscordThread_sentryIssueKey_unique" UNIQUE("sentryIssueKey"),
	CONSTRAINT "SentryIncidentDiscordThread_threadId_unique" UNIQUE("threadId")
);
--> statement-breakpoint
CREATE TABLE "SentryIncidentRun" (
	"id" text PRIMARY KEY NOT NULL,
	"inboxId" text NOT NULL,
	"sentryIssueKey" text NOT NULL,
	"issueId" text,
	"issueShortId" text,
	"action" text,
	"workerId" text NOT NULL,
	"status" "SentryIncidentRunStatus" DEFAULT 'running' NOT NULL,
	"decision" "SentryIncidentRunDecision" DEFAULT 'pending' NOT NULL,
	"linearIssueId" text,
	"linearIssueUrl" text,
	"codexSessionId" text,
	"summary" text,
	"resultReason" text,
	"error" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"finishedAt" timestamp,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "FeedEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"surface" text NOT NULL,
	"actionType" text NOT NULL,
	"itemId" text NOT NULL,
	"itemType" text NOT NULL,
	"clusterId" text,
	"marketId" text,
	"topicKey" text,
	"authorId" text,
	"feedPosition" integer,
	"dwellMs" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TradingFeeOutbox" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"tradeType" text NOT NULL,
	"tradeAmount" numeric(24, 8) NOT NULL,
	"tradeId" text,
	"marketId" text,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WorldStateSnapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"windowId" varchar(50) NOT NULL,
	"packId" text,
	"gameDay" integer NOT NULL,
	"gameTime" timestamp NOT NULL,
	"predictionMarketsJson" text,
	"perpMarketsJson" text,
	"worldEventsJson" text,
	"activeStoriesJson" text,
	"insiderAssignmentsJson" text,
	"arcPhase" varchar(20),
	"arcPlanJson" text,
	"orgStatesJson" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "UserPnLSnapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"snapshotAt" timestamp NOT NULL,
	"lifetimePnL" double precision DEFAULT 0 NOT NULL,
	"unrealizedPnL" double precision DEFAULT 0 NOT NULL,
	"currentPnL" double precision DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "UserPnLSnapshot_userId_snapshotAt_key" UNIQUE("userId","snapshotAt")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"server_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"username" text,
	"system" text DEFAULT '',
	"bio" jsonb DEFAULT '[]'::jsonb,
	"message_examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"post_examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adjectives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"knowledge" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plugins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cache" (
	"key" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "cache_key_agent_id_pk" PRIMARY KEY("key","agent_id")
);
--> statement-breakpoint
CREATE TABLE "channel_participants" (
	"channel_id" text NOT NULL,
	"entity_id" text NOT NULL,
	CONSTRAINT "channel_participants_channel_id_entity_id_pk" PRIMARY KEY("channel_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"message_server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"source_type" text,
	"source_id" text,
	"topic" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"world_id" uuid,
	"source_entity_id" uuid,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"names" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "id_agent_id_unique" UNIQUE("id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entity_id" uuid NOT NULL,
	"body" jsonb NOT NULL,
	"type" text NOT NULL,
	"room_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"content" jsonb NOT NULL,
	"entity_id" uuid,
	"agent_id" uuid NOT NULL,
	"room_id" uuid,
	"world_id" uuid,
	"unique" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "fragment_metadata_check" CHECK (
            CASE 
                WHEN metadata->>'type' = 'fragment' THEN
                    metadata ? 'documentId' AND 
                    metadata ? 'position'
                ELSE true
            END
        ),
	CONSTRAINT "document_metadata_check" CHECK (
            CASE 
                WHEN metadata->>'type' = 'document' THEN
                    metadata ? 'timestamp'
                ELSE true
            END
        )
);
--> statement-breakpoint
CREATE TABLE "message_server_agents" (
	"message_server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	CONSTRAINT "message_server_agents_message_server_id_agent_id_pk" PRIMARY KEY("message_server_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "message_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "central_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"raw_message" jsonb,
	"in_reply_to_root_message_id" text,
	"source_type" text,
	"source_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entity_id" uuid,
	"room_id" uuid,
	"agent_id" uuid,
	"room_state" text
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tags" text[],
	"metadata" jsonb,
	CONSTRAINT "unique_relationship" UNIQUE("source_entity_id","target_entity_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"message_server_id" uuid,
	"world_id" uuid,
	"name" text,
	"metadata" jsonb,
	"channel_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"room_id" uuid,
	"world_id" uuid,
	"entity_id" uuid,
	"agent_id" uuid NOT NULL,
	"tags" text[] DEFAULT '{}'::text[],
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"metadata" jsonb,
	"message_server_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "PerpMarketSnapshot" ADD COLUMN "bidPrice" double precision;--> statement-breakpoint
ALTER TABLE "PerpMarketSnapshot" ADD COLUMN "askPrice" double precision;--> statement-breakpoint
ALTER TABLE "PerpMarketSnapshot" ADD COLUMN "spreadBps" double precision;--> statement-breakpoint
ALTER TABLE "PerpMarketSnapshot" ADD COLUMN "bidDepth" double precision;--> statement-breakpoint
ALTER TABLE "PerpMarketSnapshot" ADD COLUMN "askDepth" double precision;--> statement-breakpoint
ALTER TABLE "PerpMarketSnapshot" ADD COLUMN "liquidityRegime" text;--> statement-breakpoint
ALTER TABLE "PerpMarketSnapshot" ADD COLUMN "quoteUpdatedAt" timestamp;--> statement-breakpoint
ALTER TABLE "Question" ADD COLUMN "topicKey" text;--> statement-breakpoint
ALTER TABLE "Question" ADD COLUMN "topicLabel" text;--> statement-breakpoint
ALTER TABLE "Question" ADD COLUMN "topicDate" timestamp;--> statement-breakpoint
ALTER TABLE "Message" ADD COLUMN "replyToMessageId" text;--> statement-breakpoint
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" text;--> statement-breakpoint
ALTER TABLE "Notification" ADD COLUMN "data" jsonb;--> statement-breakpoint
ALTER TABLE "ParodyHeadline" ADD COLUMN "qualityScore" double precision;--> statement-breakpoint
ALTER TABLE "ParodyHeadline" ADD COLUMN "qualityReasons" json;--> statement-breakpoint
ALTER TABLE "ParodyHeadline" ADD COLUMN "generationDepth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "WorldFact" ADD COLUMN "qualityScore" double precision;--> statement-breakpoint
ALTER TABLE "WorldFact" ADD COLUMN "generationDepth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "TimeframedMarket" ADD COLUMN "topicKey" text;--> statement-breakpoint
ALTER TABLE "TimeframedMarket" ADD COLUMN "topicLabel" text;--> statement-breakpoint
ALTER TABLE "TimeframedMarket" ADD COLUMN "topicDate" timestamp;--> statement-breakpoint
ALTER TABLE "trajectories" ADD COLUMN "worldStateSnapshotId" text;--> statement-breakpoint
ALTER TABLE "trajectories" ADD COLUMN "packId" text;--> statement-breakpoint
ALTER TABLE "trajectories" ADD COLUMN "npcRole" varchar(20);--> statement-breakpoint
ALTER TABLE "trajectories" ADD COLUMN "questionIds" text;--> statement-breakpoint
ALTER TABLE "trajectories" ADD COLUMN "eventIds" text;--> statement-breakpoint
ALTER TABLE "trajectories" ADD COLUMN "arcPhase" varchar(20);--> statement-breakpoint
ALTER TABLE "trajectories" ADD COLUMN "memorySnapshotJson" text;--> statement-breakpoint
ALTER TABLE "trajectories" ADD COLUMN "relationshipSnapshotJson" text;--> statement-breakpoint
ALTER TABLE "UserAgentConfig" ADD COLUMN "autonomousTransfers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "privySolanaWalletId" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "solanaOfflineWalletReady" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "solanaOfflineWalletReadyAt" timestamp;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "solanaWalletAddress" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "hasTelegram" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "pointsAwardedForTelegram" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "solanaRegistered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "solanaRegistryAssetId" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "solanaMetadataUri" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "solanaRegistrationTxHash" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "solanaRegisteredAt" timestamp;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "telegramId" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "telegramUsername" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "telegramVerifiedAt" timestamp;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "notificationDigestEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "notificationDigestFrequency" text DEFAULT 'daily' NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "notificationDigestDeliveryChannel" text DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "notificationDigestLastSentAt" timestamp;--> statement-breakpoint
ALTER TABLE "UserPnLSnapshot" ADD CONSTRAINT "UserPnLSnapshot_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache" ADD CONSTRAINT "cache_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_participants" ADD CONSTRAINT "channel_participants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_message_server_id_message_servers_id_fk" FOREIGN KEY ("message_server_id") REFERENCES "public"."message_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "fk_room" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "fk_user" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_room" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_user" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_agent" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_server_agents" ADD CONSTRAINT "message_server_agents_message_server_id_message_servers_id_fk" FOREIGN KEY ("message_server_id") REFERENCES "public"."message_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_server_agents" ADD CONSTRAINT "message_server_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "central_messages" ADD CONSTRAINT "central_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "central_messages" ADD CONSTRAINT "central_messages_in_reply_to_root_message_id_central_messages_id_fk" FOREIGN KEY ("in_reply_to_root_message_id") REFERENCES "public"."central_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "fk_room" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "fk_user" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "fk_user_a" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "fk_user_b" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "DailyTopic_date_idx" ON "DailyTopic" USING btree ("date");--> statement-breakpoint
CREATE INDEX "DailyTopic_topicKey_idx" ON "DailyTopic" USING btree ("topicKey");--> statement-breakpoint
CREATE INDEX "DailyTopic_isLocked_date_idx" ON "DailyTopic" USING btree ("isLocked","date");--> statement-breakpoint
CREATE INDEX "SentryIncidentAlertOutbox_status_nextAttemptAt_idx" ON "SentryIncidentAlertOutbox" USING btree ("status","nextAttemptAt");--> statement-breakpoint
CREATE INDEX "SentryIncidentAlertOutbox_issueKey_createdAt_idx" ON "SentryIncidentAlertOutbox" USING btree ("sentryIssueKey","createdAt");--> statement-breakpoint
CREATE INDEX "SentryIncidentAlertOutbox_runId_idx" ON "SentryIncidentAlertOutbox" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "SentryIncidentAlertOutbox_inboxId_idx" ON "SentryIncidentAlertOutbox" USING btree ("inboxId");--> statement-breakpoint
CREATE INDEX "SentryIncidentDiscordThread_threadId_idx" ON "SentryIncidentDiscordThread" USING btree ("threadId");--> statement-breakpoint
CREATE INDEX "SentryIncidentRun_inboxId_idx" ON "SentryIncidentRun" USING btree ("inboxId");--> statement-breakpoint
CREATE INDEX "SentryIncidentRun_issueKey_createdAt_idx" ON "SentryIncidentRun" USING btree ("sentryIssueKey","createdAt");--> statement-breakpoint
CREATE INDEX "SentryIncidentRun_linearIssueId_idx" ON "SentryIncidentRun" USING btree ("linearIssueId");--> statement-breakpoint
CREATE INDEX "SentryIncidentRun_status_createdAt_idx" ON "SentryIncidentRun" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "FeedEvent_actionType_createdAt_idx" ON "FeedEvent" USING btree ("actionType","createdAt");--> statement-breakpoint
CREATE INDEX "FeedEvent_clusterId_createdAt_idx" ON "FeedEvent" USING btree ("clusterId","createdAt");--> statement-breakpoint
CREATE INDEX "FeedEvent_itemId_createdAt_idx" ON "FeedEvent" USING btree ("itemId","createdAt");--> statement-breakpoint
CREATE INDEX "FeedEvent_surface_createdAt_idx" ON "FeedEvent" USING btree ("surface","createdAt");--> statement-breakpoint
CREATE INDEX "FeedEvent_topicKey_createdAt_idx" ON "FeedEvent" USING btree ("topicKey","createdAt");--> statement-breakpoint
CREATE INDEX "FeedEvent_userId_surface_createdAt_idx" ON "FeedEvent" USING btree ("userId","surface","createdAt");--> statement-breakpoint
CREATE INDEX "TradingFeeOutbox_createdAt_idx" ON "TradingFeeOutbox" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "TradingFeeOutbox_userId_createdAt_idx" ON "TradingFeeOutbox" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "world_state_snapshots_windowId_idx" ON "WorldStateSnapshot" USING btree ("windowId");--> statement-breakpoint
CREATE INDEX "world_state_snapshots_packId_idx" ON "WorldStateSnapshot" USING btree ("packId");--> statement-breakpoint
CREATE INDEX "UserPnLSnapshot_userId_snapshotAt_idx" ON "UserPnLSnapshot" USING btree ("userId","snapshotAt");--> statement-breakpoint
CREATE INDEX "UserPnLSnapshot_snapshotAt_idx" ON "UserPnLSnapshot" USING btree ("snapshotAt");--> statement-breakpoint
CREATE INDEX "idx_memories_type_room" ON "memories" USING btree ("type","room_id");--> statement-breakpoint
CREATE INDEX "idx_memories_world_id" ON "memories" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "idx_memories_metadata_type" ON "memories" USING btree (((metadata->>'type')));--> statement-breakpoint
CREATE INDEX "idx_memories_document_id" ON "memories" USING btree (((metadata->>'documentId')));--> statement-breakpoint
CREATE INDEX "idx_fragments_order" ON "memories" USING btree (((metadata->>'documentId')),((metadata->>'position')));--> statement-breakpoint
CREATE INDEX "idx_participants_user" ON "participants" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_participants_room" ON "participants" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_relationships_users" ON "relationships" USING btree ("source_entity_id","target_entity_id");--> statement-breakpoint
CREATE INDEX "UserAchievement_userId_unlockedAt_idx" ON "UserAchievement" USING btree ("userId","unlockedAt");--> statement-breakpoint
CREATE INDEX "PerpPosition_userId_openedAt_idx" ON "PerpPosition" USING btree ("userId","openedAt");--> statement-breakpoint
CREATE INDEX "Position_createdAt_idx" ON "Position" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Position_status_resolvedAt_idx" ON "Position" USING btree ("status","resolvedAt");--> statement-breakpoint
CREATE INDEX "Position_userId_createdAt_idx" ON "Position" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "Position_userId_resolvedAt_idx" ON "Position" USING btree ("userId","resolvedAt");--> statement-breakpoint
CREATE INDEX "Question_topicKey_topicDate_idx" ON "Question" USING btree ("topicKey","topicDate");--> statement-breakpoint
CREATE INDEX "GroupMember_userId_joinedAt_idx" ON "GroupMember" USING btree ("userId","joinedAt");--> statement-breakpoint
CREATE INDEX "Group_createdById_createdAt_idx" ON "Group" USING btree ("createdById","createdAt");--> statement-breakpoint
CREATE INDEX "Message_senderId_createdAt_idx" ON "Message" USING btree ("senderId","createdAt");--> statement-breakpoint
CREATE INDEX "Message_replyToMessageId_idx" ON "Message" USING btree ("replyToMessageId");--> statement-breakpoint
CREATE UNIQUE INDEX "Notification_dedupeKey_unique" ON "Notification" USING btree ("dedupeKey") WHERE "Notification"."dedupeKey" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "Notification_userId_type_actorId_createdAt_idx" ON "Notification" USING btree ("userId","type","actorId","createdAt");--> statement-breakpoint
CREATE INDEX "TimeframedMarket_topicKey_topicDate_idx" ON "TimeframedMarket" USING btree ("topicKey","topicDate");--> statement-breakpoint
CREATE INDEX "TimeframedMarket_isActive_isResolved_endTime_idx" ON "TimeframedMarket" USING btree ("isActive","isResolved","endTime");--> statement-breakpoint
CREATE INDEX "Comment_authorId_createdAt_idx" ON "Comment" USING btree ("authorId","createdAt");--> statement-breakpoint
CREATE INDEX "Post_createdAt_idx" ON "Post" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Reaction_userId_createdAt_idx" ON "Reaction" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "Share_userId_createdAt_idx" ON "Share" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "UserActivityLog_userId_activityType_idx" ON "UserActivityLog" USING btree ("userId","activityType");--> statement-breakpoint
CREATE INDEX "Follow_followerId_createdAt_idx" ON "Follow" USING btree ("followerId","createdAt");--> statement-breakpoint
CREATE INDEX "User_createdAt_idx" ON "User" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "User_managedBy_isAgent_createdAt_idx" ON "User" USING btree ("managedBy","isAgent","createdAt");--> statement-breakpoint
ALTER TABLE "User" ADD CONSTRAINT "User_solanaWalletAddress_unique" UNIQUE("solanaWalletAddress");--> statement-breakpoint
ALTER TABLE "User" ADD CONSTRAINT "User_telegramId_unique" UNIQUE("telegramId");