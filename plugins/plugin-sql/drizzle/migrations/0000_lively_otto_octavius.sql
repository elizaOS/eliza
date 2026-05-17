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
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"requested_by" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"channel" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_reason" text,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"actor_identity_id" text,
	"ip" text,
	"user_agent" text,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"metadata" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_bootstrap_jti_seen" (
	"jti" text PRIMARY KEY NOT NULL,
	"seen_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"password_hash" text,
	"cloud_user_id" text
);
--> statement-breakpoint
CREATE TABLE "auth_owner_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_id" text NOT NULL,
	"connector" text NOT NULL,
	"external_id" text NOT NULL,
	"display_handle" text NOT NULL,
	"instance_id" text NOT NULL,
	"verified_at" bigint NOT NULL,
	"pending_code_hash" text,
	"pending_expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"remember_device" boolean DEFAULT false NOT NULL,
	"csrf_secret" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"scopes" jsonb NOT NULL,
	"revoked_at" bigint
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
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"dim_384" vector(384),
	"dim_512" vector(512),
	"dim_768" vector(768),
	"dim_1024" vector(1024),
	"dim_1536" vector(1536),
	"dim_3072" vector(3072),
	CONSTRAINT "embedding_source_check" CHECK ("memory_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "entity_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"source" text,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_message_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unique_entity_identity" UNIQUE("entity_id","platform","handle","agent_id")
);
--> statement-breakpoint
CREATE TABLE "entity_merge_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"entity_a" uuid NOT NULL,
	"entity_b" uuid NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"evidence" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
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
CREATE TABLE "fact_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"existing_fact_id" uuid,
	"proposed_text" text NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"evidence" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
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
CREATE TABLE "long_term_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"embedding" real[],
	"confidence" real DEFAULT 1,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp,
	"access_count" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "memory_access_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"memory_type" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"access_type" text NOT NULL,
	"accessed_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "pairing_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"sender_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"agent_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairing_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"sender_id" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"agent_id" uuid NOT NULL
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
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_summaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"entity_id" uuid,
	"summary" text NOT NULL,
	"message_count" integer NOT NULL,
	"last_message_offset" integer DEFAULT 0 NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp NOT NULL,
	"topics" jsonb,
	"metadata" jsonb,
	"embedding" real[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_owner_bindings" ADD CONSTRAINT "auth_owner_bindings_identity_id_auth_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_owner_bindings" ADD CONSTRAINT "fk_auth_owner_bindings_identity" FOREIGN KEY ("identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_identity_id_auth_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "fk_auth_sessions_identity" FOREIGN KEY ("identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache" ADD CONSTRAINT "cache_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_participants" ADD CONSTRAINT "channel_participants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_message_server_id_message_servers_id_fk" FOREIGN KEY ("message_server_id") REFERENCES "public"."message_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "fk_embedding_memory" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "entity_identities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "entity_identities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "fk_entity_identities_entity" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identities" ADD CONSTRAINT "fk_entity_identities_agent" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merge_candidates" ADD CONSTRAINT "entity_merge_candidates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merge_candidates" ADD CONSTRAINT "entity_merge_candidates_entity_a_entities_id_fk" FOREIGN KEY ("entity_a") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merge_candidates" ADD CONSTRAINT "entity_merge_candidates_entity_b_entities_id_fk" FOREIGN KEY ("entity_b") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merge_candidates" ADD CONSTRAINT "fk_entity_merge_candidates_a" FOREIGN KEY ("entity_a") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merge_candidates" ADD CONSTRAINT "fk_entity_merge_candidates_b" FOREIGN KEY ("entity_b") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merge_candidates" ADD CONSTRAINT "fk_entity_merge_candidates_agent" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_candidates" ADD CONSTRAINT "fact_candidates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_candidates" ADD CONSTRAINT "fact_candidates_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_candidates" ADD CONSTRAINT "fk_fact_candidates_entity" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_candidates" ADD CONSTRAINT "fk_fact_candidates_agent" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "pairing_allowlist" ADD CONSTRAINT "pairing_allowlist_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_requests" ADD CONSTRAINT "pairing_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "approval_requests_subject_state_idx" ON "approval_requests" USING btree ("subject_user_id","state");--> statement-breakpoint
CREATE INDEX "approval_requests_agent_state_idx" ON "approval_requests" USING btree ("agent_id","state");--> statement-breakpoint
CREATE INDEX "approval_requests_state_expires_idx" ON "approval_requests" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "auth_audit_events_action_idx" ON "auth_audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "auth_audit_events_ts_idx" ON "auth_audit_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "auth_audit_events_actor_idx" ON "auth_audit_events" USING btree ("actor_identity_id");--> statement-breakpoint
CREATE INDEX "auth_bootstrap_jti_seen_at_idx" ON "auth_bootstrap_jti_seen" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "auth_identities_kind_idx" ON "auth_identities" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "auth_identities_cloud_user_idx" ON "auth_identities" USING btree ("cloud_user_id");--> statement-breakpoint
CREATE INDEX "auth_owner_bindings_identity_idx" ON "auth_owner_bindings" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "auth_owner_bindings_connector_idx" ON "auth_owner_bindings" USING btree ("connector");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_owner_bindings_connector_external_instance_uniq" ON "auth_owner_bindings" USING btree ("connector","external_id","instance_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_identity_idx" ON "auth_sessions" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_embedding_memory" ON "embeddings" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "idx_entity_identities_entity" ON "entity_identities" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_entity_identities_platform_handle" ON "entity_identities" USING btree ("platform","handle");--> statement-breakpoint
CREATE INDEX "idx_entity_merge_candidates_status" ON "entity_merge_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_entity_merge_candidates_pair" ON "entity_merge_candidates" USING btree ("entity_a","entity_b");--> statement-breakpoint
CREATE INDEX "idx_fact_candidates_status" ON "fact_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fact_candidates_entity" ON "fact_candidates" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "long_term_memories_agent_entity_idx" ON "long_term_memories" USING btree ("agent_id","entity_id");--> statement-breakpoint
CREATE INDEX "long_term_memories_category_idx" ON "long_term_memories" USING btree ("category");--> statement-breakpoint
CREATE INDEX "long_term_memories_confidence_idx" ON "long_term_memories" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "long_term_memories_created_at_idx" ON "long_term_memories" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "memory_access_logs_memory_id_idx" ON "memory_access_logs" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_access_logs_agent_id_idx" ON "memory_access_logs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "memory_access_logs_accessed_at_idx" ON "memory_access_logs" USING btree ("accessed_at");--> statement-breakpoint
CREATE INDEX "idx_memories_type_room" ON "memories" USING btree ("type","room_id");--> statement-breakpoint
CREATE INDEX "idx_memories_world_id" ON "memories" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "idx_memories_metadata_type" ON "memories" USING btree (((metadata->>'type')));--> statement-breakpoint
CREATE INDEX "idx_memories_document_id" ON "memories" USING btree (((metadata->>'documentId')));--> statement-breakpoint
CREATE INDEX "idx_fragments_order" ON "memories" USING btree (((metadata->>'documentId')),((metadata->>'position')));--> statement-breakpoint
CREATE INDEX "pairing_allowlist_channel_agent_idx" ON "pairing_allowlist" USING btree ("channel","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_allowlist_sender_channel_agent_idx" ON "pairing_allowlist" USING btree ("sender_id","channel","agent_id");--> statement-breakpoint
CREATE INDEX "pairing_requests_channel_agent_idx" ON "pairing_requests" USING btree ("channel","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_requests_code_channel_agent_idx" ON "pairing_requests" USING btree ("code","channel","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_requests_sender_channel_agent_idx" ON "pairing_requests" USING btree ("sender_id","channel","agent_id");--> statement-breakpoint
CREATE INDEX "idx_participants_user" ON "participants" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_participants_room" ON "participants" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_relationships_users" ON "relationships" USING btree ("source_entity_id","target_entity_id");--> statement-breakpoint
CREATE INDEX "session_summaries_agent_room_idx" ON "session_summaries" USING btree ("agent_id","room_id");--> statement-breakpoint
CREATE INDEX "session_summaries_entity_idx" ON "session_summaries" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "session_summaries_start_time_idx" ON "session_summaries" USING btree ("start_time");