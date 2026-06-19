-- Add Telegram identity fields to the User table
-- Follows the same pattern as Discord (discordId, discordUsername, hasDiscord, pointsAwardedForDiscord)

ALTER TABLE "User" ADD COLUMN "hasTelegram" boolean NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "pointsAwardedForTelegram" boolean NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "telegramId" text;
ALTER TABLE "User" ADD COLUMN "telegramUsername" text;
ALTER TABLE "User" ADD COLUMN "telegramVerifiedAt" timestamp;

-- Add unique constraint on telegramId (prevents duplicate Telegram accounts)
ALTER TABLE "User" ADD CONSTRAINT "User_telegramId_unique" UNIQUE("telegramId");
