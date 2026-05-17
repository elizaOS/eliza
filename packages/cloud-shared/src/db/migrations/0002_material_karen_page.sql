CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"provider" text NOT NULL,
	"event_type" text,
	"payload_hash" text NOT NULL,
	"source_ip" text,
	"processed_at" timestamp DEFAULT now() NOT NULL,
	"event_timestamp" timestamp,
	CONSTRAINT "webhook_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT "unique_relationship";--> statement-breakpoint
ALTER TABLE "components" DROP CONSTRAINT "components_entityId_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "components" DROP CONSTRAINT "components_agentId_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "components" DROP CONSTRAINT "components_roomId_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "components" DROP CONSTRAINT "components_worldId_worlds_id_fk";
--> statement-breakpoint
ALTER TABLE "components" DROP CONSTRAINT "components_sourceEntityId_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "logs" DROP CONSTRAINT "logs_entityId_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "logs" DROP CONSTRAINT "logs_roomId_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "logs" DROP CONSTRAINT "fk_room";
--> statement-breakpoint
ALTER TABLE "logs" DROP CONSTRAINT "fk_user";
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "memories_entityId_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "memories_agentId_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "memories_roomId_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "fk_room";
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "fk_user";
--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "fk_agent";
--> statement-breakpoint
ALTER TABLE "participants" DROP CONSTRAINT "participants_entityId_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "participants" DROP CONSTRAINT "participants_roomId_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "participants" DROP CONSTRAINT "participants_agentId_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "participants" DROP CONSTRAINT "fk_room";
--> statement-breakpoint
ALTER TABLE "participants" DROP CONSTRAINT "fk_user";
--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT "relationships_sourceEntityId_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT "relationships_targetEntityId_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT "relationships_agentId_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT "fk_user_a";
--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT "fk_user_b";
--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_agentId_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_agentId_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "worlds" DROP CONSTRAINT "worlds_agentId_agents_id_fk";
--> statement-breakpoint
DROP INDEX "idx_memories_type_room";--> statement-breakpoint
DROP INDEX "idx_memories_world_id";--> statement-breakpoint
DROP INDEX "idx_participants_user";--> statement-breakpoint
DROP INDEX "idx_participants_room";--> statement-breakpoint
DROP INDEX "idx_relationships_users";--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "entity_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "agent_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "room_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "world_id" uuid;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "source_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "logs" ADD COLUMN "entity_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "logs" ADD COLUMN "room_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "agent_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "world_id" uuid;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "room_state" text;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "source_entity_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "target_entity_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "agent_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "world_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "world_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "agent_id" uuid NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_event_id_idx" ON "webhook_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_provider_idx" ON "webhook_events" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "webhook_events_processed_at_idx" ON "webhook_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "webhook_events_provider_processed_idx" ON "webhook_events" USING btree ("provider","processed_at");--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "idx_memories_type_room" ON "memories" USING btree ("type","room_id");--> statement-breakpoint
CREATE INDEX "idx_memories_world_id" ON "memories" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "idx_participants_user" ON "participants" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_participants_room" ON "participants" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_relationships_users" ON "relationships" USING btree ("source_entity_id","target_entity_id");--> statement-breakpoint
ALTER TABLE "components" DROP COLUMN "entityId";--> statement-breakpoint
ALTER TABLE "components" DROP COLUMN "agentId";--> statement-breakpoint
ALTER TABLE "components" DROP COLUMN "roomId";--> statement-breakpoint
ALTER TABLE "components" DROP COLUMN "worldId";--> statement-breakpoint
ALTER TABLE "components" DROP COLUMN "sourceEntityId";--> statement-breakpoint
ALTER TABLE "components" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "logs" DROP COLUMN "entityId";--> statement-breakpoint
ALTER TABLE "logs" DROP COLUMN "roomId";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "entityId";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "agentId";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "roomId";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "worldId";--> statement-breakpoint
ALTER TABLE "participants" DROP COLUMN "entityId";--> statement-breakpoint
ALTER TABLE "participants" DROP COLUMN "roomId";--> statement-breakpoint
ALTER TABLE "participants" DROP COLUMN "agentId";--> statement-breakpoint
ALTER TABLE "participants" DROP COLUMN "roomState";--> statement-breakpoint
ALTER TABLE "relationships" DROP COLUMN "sourceEntityId";--> statement-breakpoint
ALTER TABLE "relationships" DROP COLUMN "targetEntityId";--> statement-breakpoint
ALTER TABLE "relationships" DROP COLUMN "agentId";--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "agentId";--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "worldId";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "roomId";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "worldId";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "entityId";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "agentId";--> statement-breakpoint
ALTER TABLE "worlds" DROP COLUMN "agentId";--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "unique_relationship" UNIQUE("source_entity_id","target_entity_id","agent_id");