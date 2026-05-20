-- Add foreign key constraints to MessageReaction table
-- messageId cascades on delete so reactions are cleaned up when a message is removed
-- chatId cascades on delete for consistency
-- userId cascades on delete if the user account is removed

ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_Message_id_fk"
  FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_chatId_Chat_id_fk"
  FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_User_id_fk"
  FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
