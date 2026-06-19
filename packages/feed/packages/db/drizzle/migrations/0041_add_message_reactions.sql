CREATE TABLE IF NOT EXISTS "MessageReaction" (
	"id" text PRIMARY KEY NOT NULL,
	"chatId" text NOT NULL,
	"messageId" text NOT NULL,
	"userId" text NOT NULL,
	"emoji" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "MessageReaction_messageId_userId_emoji_key" UNIQUE("messageId","userId","emoji")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "MessageReaction_messageId_idx" ON "MessageReaction" USING btree ("messageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "MessageReaction_chatId_idx" ON "MessageReaction" USING btree ("chatId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "MessageReaction_userId_idx" ON "MessageReaction" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "MessageReaction_chatId_messageId_idx" ON "MessageReaction" USING btree ("chatId","messageId");

