CREATE TYPE "public"."group_type" AS ENUM('user', 'npc', 'agent');--> statement-breakpoint
DROP INDEX "ChatParticipant_lastMessageAt_idx";--> statement-breakpoint
ALTER TABLE "Group" ALTER COLUMN "type" SET DATA TYPE "public"."group_type" USING "type"::"public"."group_type";--> statement-breakpoint
ALTER TABLE "ChatParticipant" DROP COLUMN "lastMessageAt";--> statement-breakpoint
ALTER TABLE "ChatParticipant" DROP COLUMN "messageCount";--> statement-breakpoint
ALTER TABLE "ChatParticipant" DROP COLUMN "qualityScore";--> statement-breakpoint
ALTER TABLE "ChatParticipant" DROP COLUMN "kickedAt";--> statement-breakpoint
ALTER TABLE "ChatParticipant" DROP COLUMN "kickReason";