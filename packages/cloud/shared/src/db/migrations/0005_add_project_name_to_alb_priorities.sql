ALTER TABLE "alb_priorities" DROP CONSTRAINT "alb_priorities_user_id_unique";--> statement-breakpoint
ALTER TABLE "alb_priorities" ADD COLUMN "project_name" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "alb_priorities_user_project_idx" ON "alb_priorities" USING btree ("user_id","project_name");