CREATE TYPE "sensitive_request_kind" AS ENUM (
  'secret',
  'payment',
  'oauth',
  'private_info'
);

CREATE TYPE "sensitive_request_status" AS ENUM (
  'pending',
  'fulfilled',
  'failed',
  'canceled',
  'expired'
);

CREATE TYPE "sensitive_request_audit_event" AS ENUM (
  'request.created',
  'request.viewed',
  'request.submitted',
  'request.fulfilled',
  'request.failed',
  'request.canceled',
  'request.expired',
  'token.used',
  'secret.set',
  'private_info.submitted'
);

CREATE TYPE "sensitive_request_actor_type" AS ENUM (
  'user',
  'api_key',
  'token',
  'system'
);

CREATE TABLE "sensitive_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "sensitive_request_kind" NOT NULL,
  "status" "sensitive_request_status" DEFAULT 'pending' NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id") ON DELETE cascade,
  "agent_id" text NOT NULL,
  "owner_entity_id" text,
  "requester_entity_id" text,
  "source_room_id" text,
  "source_channel_type" text,
  "source_platform" text,
  "target" jsonb NOT NULL,
  "policy" jsonb NOT NULL,
  "delivery" jsonb NOT NULL,
  "callback" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "token_hash" text,
  "token_used_at" timestamp,
  "expires_at" timestamp NOT NULL,
  "fulfilled_at" timestamp,
  "canceled_at" timestamp,
  "expired_at" timestamp,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "sensitive_request_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL REFERENCES "sensitive_requests"("id") ON DELETE cascade,
  "organization_id" uuid REFERENCES "organizations"("id") ON DELETE cascade,
  "event_type" "sensitive_request_audit_event" NOT NULL,
  "actor_type" "sensitive_request_actor_type" DEFAULT 'system' NOT NULL,
  "actor_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "sensitive_requests_organization_idx"
  ON "sensitive_requests" ("organization_id");

CREATE INDEX "sensitive_requests_agent_idx"
  ON "sensitive_requests" ("agent_id");

CREATE INDEX "sensitive_requests_status_expires_idx"
  ON "sensitive_requests" ("status", "expires_at");

CREATE UNIQUE INDEX "sensitive_requests_token_hash_idx"
  ON "sensitive_requests" ("token_hash");

CREATE INDEX "sensitive_requests_created_by_idx"
  ON "sensitive_requests" ("created_by");

CREATE INDEX "sensitive_request_events_request_created_idx"
  ON "sensitive_request_events" ("request_id", "created_at");

CREATE INDEX "sensitive_request_events_organization_created_idx"
  ON "sensitive_request_events" ("organization_id", "created_at");

CREATE INDEX "sensitive_request_events_event_type_idx"
  ON "sensitive_request_events" ("event_type");
