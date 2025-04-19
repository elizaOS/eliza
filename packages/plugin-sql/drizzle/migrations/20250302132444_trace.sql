CREATE TABLE "traces" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "traceId" uuid NOT NULL,
    "spanId" text NOT NULL,
    "parentSpanId" text,
    "name" text NOT NULL,
    "startTime" timestamptz NOT NULL,
    "endTime" timestamptz NOT NULL,
    "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "events" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "status" jsonb NOT NULL DEFAULT '{"code": 0}'::jsonb,
    "entityId" uuid NOT NULL,
    "createdAt" timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT "fk_entity" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "traces_traceId_idx" ON "traces" ("traceId");
--> statement-breakpoint
CREATE INDEX "traces_entityId_idx" ON "traces" ("entityId"); 