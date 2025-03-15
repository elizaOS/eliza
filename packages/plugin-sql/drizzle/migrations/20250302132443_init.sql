CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint				
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamptz DEFAULT now() NOT NULL,
	"updatedAt" timestamptz DEFAULT now() NOT NULL,
	"name" text,
	"username" text,
	"system" text,
	"bio" jsonb NOT NULL,
	"message_examples" jsonb DEFAULT '[]'::jsonb,
	"post_examples" jsonb DEFAULT '[]'::jsonb,
	"topics" jsonb DEFAULT '[]'::jsonb,
	"adjectives" jsonb DEFAULT '[]'::jsonb,
	"knowledge" jsonb DEFAULT '[]'::jsonb,
	"plugins" jsonb DEFAULT '[]'::jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"style" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"agentId" uuid NOT NULL,
	"value" jsonb NOT NULL,
	"createdAt" timestamptz DEFAULT now() NOT NULL,
	"expiresAt" timestamptz,
	CONSTRAINT "cache_key_agent_unique" UNIQUE("key","agentId")
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"agentId" uuid NOT NULL,
	"roomId" uuid NOT NULL,
	"worldId" uuid,
	"sourceEntityId" uuid,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb,
	"createdAt" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"dim_384" vector(384),
	"dim_512" vector(512),
	"dim_768" vector(768),
	"dim_1024" vector(1024),
	"dim_1536" vector(1536),
	"dim_3072" vector(3072),
	CONSTRAINT "embedding_source_check" CHECK ("memory_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agentId" uuid NOT NULL,
	"createdAt" timestamptz DEFAULT now() NOT NULL,
	"names" text[] DEFAULT '{}'::text[],
	"metadata" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "id_agent_id_unique" UNIQUE("id","agentId")
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"createdAt" timestamptz DEFAULT now() NOT NULL,
	"entityId" uuid NOT NULL,
	"body" jsonb NOT NULL,
	"type" text NOT NULL,
	"roomId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"createdAt" timestamptz DEFAULT now() NOT NULL,
	"content" jsonb NOT NULL,
	"entityId" uuid,
	"agentId" uuid,
	"roomId" uuid,
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
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"createdAt" timestamptz DEFAULT now() NOT NULL,
	"entityId" uuid,
	"roomId" uuid,
	"agentId" uuid,
	"roomState" text
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"createdAt" timestamptz DEFAULT now() NOT NULL,
	"sourceEntityId" uuid NOT NULL,
	"targetEntityId" uuid NOT NULL,
	"agentId" uuid NOT NULL,
	"tags" text[],
	"metadata" jsonb,
	CONSTRAINT "unique_relationship" UNIQUE("sourceEntityId","targetEntityId","agentId")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agentId" uuid,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"serverId" text,
	"worldId" uuid,
	"name" text,
	"metadata" jsonb,
	"channelId" text,
	"createdAt" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"room_id" uuid,
	"world_id" uuid,
	"agent_id" uuid NOT NULL,
	"tags" text[],
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agentId" uuid NOT NULL,
	"name" text NOT NULL,
	"metadata" jsonb,
	"serverId" text NOT NULL,
	"createdAt" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cache" ADD CONSTRAINT "cache_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_entityId_entities_id_fk" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_roomId_rooms_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_worldId_worlds_id_fk" FOREIGN KEY ("worldId") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_sourceEntityId_entities_id_fk" FOREIGN KEY ("sourceEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "fk_embedding_memory" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_entityId_entities_id_fk" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_roomId_rooms_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "fk_room" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "fk_user" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_entityId_entities_id_fk" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_roomId_rooms_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_room" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_user" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_agent" FOREIGN KEY ("agentId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_entityId_entities_id_fk" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_roomId_rooms_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "fk_room" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "fk_user" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_sourceEntityId_entities_id_fk" FOREIGN KEY ("sourceEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_targetEntityId_entities_id_fk" FOREIGN KEY ("targetEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "fk_user_a" FOREIGN KEY ("sourceEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "fk_user_b" FOREIGN KEY ("targetEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_worldId_worlds_id_fk" FOREIGN KEY ("worldId") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_embedding_memory" ON "embeddings" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "idx_memories_type_room" ON "memories" USING btree ("type","roomId");--> statement-breakpoint
CREATE INDEX "idx_memories_metadata_type" ON "memories" USING btree (((metadata->>'type')));--> statement-breakpoint
CREATE INDEX "idx_memories_document_id" ON "memories" USING btree (((metadata->>'documentId')));--> statement-breakpoint
CREATE INDEX "idx_fragments_order" ON "memories" USING btree (((metadata->>'documentId')),((metadata->>'position')));--> statement-breakpoint
CREATE INDEX "idx_participants_user" ON "participants" USING btree ("entityId");--> statement-breakpoint
CREATE INDEX "idx_participants_room" ON "participants" USING btree ("roomId");--> statement-breakpoint
CREATE INDEX "idx_relationships_users" ON "relationships" USING btree ("sourceEntityId","targetEntityId");