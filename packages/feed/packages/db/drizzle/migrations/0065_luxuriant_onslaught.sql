ALTER TABLE "UserPointsSnapshot" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "UserPointsSnapshot" CASCADE;--> statement-breakpoint
DROP INDEX "User_totalPoints_idx";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "totalPoints";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "totalPointsDirtyAt";