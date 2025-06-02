-- Add message server tables

-- Create message_servers table
CREATE TABLE IF NOT EXISTS "message_servers" (
    "id" text PRIMARY KEY NOT NULL, -- UUID stored as text
    "name" text NOT NULL,
    "source_type" text NOT NULL,
    "source_id" text,
    "metadata" jsonb,
    "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
-- Create channels table
CREATE TABLE IF NOT EXISTS "channels" (
    "id" text PRIMARY KEY NOT NULL,
    "server_id" text NOT NULL,
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
-- Create central_messages table
CREATE TABLE IF NOT EXISTS "central_messages" (
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
-- Create channel_participants table
CREATE TABLE IF NOT EXISTS "channel_participants" (
    "channel_id" text NOT NULL,
    "user_id" text NOT NULL,
    CONSTRAINT "channel_participants_pkey" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
-- Create server_agents table
CREATE TABLE IF NOT EXISTS "server_agents" (
    "server_id" text NOT NULL,
    "agent_id" text NOT NULL,
    CONSTRAINT "server_agents_pkey" PRIMARY KEY("server_id","agent_id")
);
--> statement-breakpoint
-- Add foreign key constraints
DO $$ BEGIN
 ALTER TABLE "channels" ADD CONSTRAINT "channels_server_id_message_servers_id_fk" 
 FOREIGN KEY ("server_id") REFERENCES "message_servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "central_messages" ADD CONSTRAINT "central_messages_channel_id_channels_id_fk" 
 FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "central_messages" ADD CONSTRAINT "central_messages_in_reply_to_root_message_id_central_messages_id_fk" 
 FOREIGN KEY ("in_reply_to_root_message_id") REFERENCES "central_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_participants" ADD CONSTRAINT "channel_participants_channel_id_channels_id_fk" 
 FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "server_agents" ADD CONSTRAINT "server_agents_server_id_message_servers_id_fk" 
 FOREIGN KEY ("server_id") REFERENCES "message_servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS "idx_channels_server_id" ON "channels" ("server_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_central_messages_channel_id" ON "central_messages" ("channel_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_central_messages_author_id" ON "central_messages" ("author_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_central_messages_created_at" ON "central_messages" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_participants_user_id" ON "channel_participants" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_server_agents_server_id" ON "server_agents" ("server_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_server_agents_agent_id" ON "server_agents" ("agent_id"); 