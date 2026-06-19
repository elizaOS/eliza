-- Add reply-to-message support (Telegram/Discord-style message replies)
-- No foreign key constraint: replied-to messages may be deleted without breaking replies.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "replyToMessageId" TEXT;
CREATE INDEX IF NOT EXISTS "Message_replyToMessageId_idx" ON "Message" ("replyToMessageId");
