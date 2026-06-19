CREATE TABLE IF NOT EXISTS "UserPnLSnapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"snapshotAt" timestamp NOT NULL,
	"lifetimePnL" double precision DEFAULT 0 NOT NULL,
	"unrealizedPnL" double precision DEFAULT 0 NOT NULL,
	"currentPnL" double precision DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "UserPnLSnapshot_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "UserPnLSnapshot_userId_snapshotAt_key" UNIQUE("userId","snapshotAt")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "UserPnLSnapshot_userId_snapshotAt_idx" ON "UserPnLSnapshot" USING btree ("userId","snapshotAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "UserPnLSnapshot_snapshotAt_idx" ON "UserPnLSnapshot" USING btree ("snapshotAt");
