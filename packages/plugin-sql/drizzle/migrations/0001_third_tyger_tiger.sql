ALTER TABLE "memories" DROP CONSTRAINT "fk_agent";
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_agent" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;