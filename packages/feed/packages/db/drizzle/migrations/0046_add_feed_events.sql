CREATE TABLE "FeedEvent" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "surface" text NOT NULL,
  "actionType" text NOT NULL,
  "itemId" text NOT NULL,
  "itemType" text NOT NULL,
  "clusterId" text,
  "marketId" text,
  "topicKey" text,
  "authorId" text,
  "feedPosition" integer,
  "dwellMs" integer,
  "createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "FeedEvent_actionType_createdAt_idx" ON "FeedEvent" USING btree ("actionType","createdAt");
--> statement-breakpoint
CREATE INDEX "FeedEvent_clusterId_createdAt_idx" ON "FeedEvent" USING btree ("clusterId","createdAt");
--> statement-breakpoint
CREATE INDEX "FeedEvent_itemId_createdAt_idx" ON "FeedEvent" USING btree ("itemId","createdAt");
--> statement-breakpoint
CREATE INDEX "FeedEvent_surface_createdAt_idx" ON "FeedEvent" USING btree ("surface","createdAt");
--> statement-breakpoint
CREATE INDEX "FeedEvent_topicKey_createdAt_idx" ON "FeedEvent" USING btree ("topicKey","createdAt");
--> statement-breakpoint
CREATE INDEX "FeedEvent_userId_surface_createdAt_idx" ON "FeedEvent" USING btree ("userId","surface","createdAt");
