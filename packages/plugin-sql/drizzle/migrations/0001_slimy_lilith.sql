ALTER TABLE "logs" DROP CONSTRAINT "logs_roomId_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_worldId_worlds_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "system" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "message_examples" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "post_examples" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "topics" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "adjectives" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "knowledge" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "plugins" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "settings" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "style" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "names" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "metadata" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "agentId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_roomId_rooms_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;