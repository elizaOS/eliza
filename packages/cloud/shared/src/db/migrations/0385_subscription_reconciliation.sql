CREATE TABLE "subscription_reconciliation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"expected_revision" bigint NOT NULL,
	"expected_projection_revision" bigint,
	"identity_digest" text NOT NULL,
	"lease_token" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"disposition" text DEFAULT 'processing' NOT NULL,
	"observation_digest" text,
	"observed_revision" bigint,
	"result_revision" bigint,
	"reason" text,
	"completed_at" timestamp with time zone,
	CONSTRAINT "subscription_reconciliation_attempt_shape" CHECK ("subscription_reconciliation_attempts"."generation">0 AND "subscription_reconciliation_attempts"."expected_revision">0 AND ("subscription_reconciliation_attempts"."expected_projection_revision" IS NULL OR "subscription_reconciliation_attempts"."expected_projection_revision">=0) AND "subscription_reconciliation_attempts"."identity_digest" ~ '^[0-9a-f]{64}$' AND "subscription_reconciliation_attempts"."expires_at">"subscription_reconciliation_attempts"."started_at" AND "subscription_reconciliation_attempts"."disposition" IN ('processing','applied','no_change','unsupported','unavailable','stale','superseded','deletion_owned') AND (("subscription_reconciliation_attempts"."disposition"='processing' AND "subscription_reconciliation_attempts"."completed_at" IS NULL AND "subscription_reconciliation_attempts"."observation_digest" IS NULL AND "subscription_reconciliation_attempts"."result_revision" IS NULL AND "subscription_reconciliation_attempts"."observed_revision" IS NULL AND "subscription_reconciliation_attempts"."reason" IS NULL) OR ("subscription_reconciliation_attempts"."disposition"<>'processing' AND "subscription_reconciliation_attempts"."completed_at" IS NOT NULL AND "subscription_reconciliation_attempts"."completed_at">="subscription_reconciliation_attempts"."started_at")) AND (("subscription_reconciliation_attempts"."disposition"='applied' AND "subscription_reconciliation_attempts"."result_revision" IS NOT NULL AND "subscription_reconciliation_attempts"."result_revision"="subscription_reconciliation_attempts"."expected_revision"+1 AND "subscription_reconciliation_attempts"."observation_digest" IS NOT NULL AND "subscription_reconciliation_attempts"."observation_digest" ~ '^[0-9a-f]{64}$' AND "subscription_reconciliation_attempts"."observed_revision" IS NOT NULL AND "subscription_reconciliation_attempts"."observed_revision"="subscription_reconciliation_attempts"."result_revision") OR ("subscription_reconciliation_attempts"."disposition"<>'applied' AND "subscription_reconciliation_attempts"."result_revision" IS NULL)) AND ("subscription_reconciliation_attempts"."observation_digest" IS NULL OR "subscription_reconciliation_attempts"."observation_digest" ~ '^[0-9a-f]{64}$') AND ("subscription_reconciliation_attempts"."disposition" IN ('processing','applied','no_change') OR "subscription_reconciliation_attempts"."reason" IS NOT NULL) AND ("subscription_reconciliation_attempts"."disposition"<>'no_change' OR ("subscription_reconciliation_attempts"."observed_revision" IS NOT NULL AND "subscription_reconciliation_attempts"."observed_revision">0 AND "subscription_reconciliation_attempts"."observation_digest" IS NOT NULL)))
);

--> statement-breakpoint
CREATE TABLE "subscription_reconciliation_scans" (
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_due_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_reconciliation_scans_organization_id_subscription_id_pk" PRIMARY KEY("organization_id","subscription_id"),
	CONSTRAINT "subscription_reconciliation_scan_shape" CHECK ("subscription_reconciliation_scans"."generation">=0 AND "subscription_reconciliation_scans"."failures">=0)
);

--> statement-breakpoint
ALTER TABLE "subscription_reconciliation_attempts" ADD CONSTRAINT "subscription_reconciliation_attempt_source_fk" FOREIGN KEY ("subscription_id","organization_id","expected_revision") REFERENCES "billing_subscription_revisions"("subscription_id","organization_id","revision") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_reconciliation_attempts" ADD CONSTRAINT "subscription_reconciliation_attempt_result_fk" FOREIGN KEY ("subscription_id","organization_id","result_revision") REFERENCES "billing_subscription_revisions"("subscription_id","organization_id","revision") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_reconciliation_attempts" ADD CONSTRAINT "subscription_reconciliation_attempt_observed_fk" FOREIGN KEY ("subscription_id","organization_id","observed_revision") REFERENCES "billing_subscription_revisions"("subscription_id","organization_id","revision") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_reconciliation_scans" ADD CONSTRAINT "subscription_reconciliation_scan_source_fk" FOREIGN KEY ("subscription_id","organization_id") REFERENCES "billing_subscriptions"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_reconciliation_attempt_generation" ON "subscription_reconciliation_attempts" USING btree ("organization_id","subscription_id","generation");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_reconciliation_attempt_result" ON "subscription_reconciliation_attempts" USING btree ("organization_id","subscription_id","result_revision") WHERE "subscription_reconciliation_attempts"."disposition"='applied';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_subscription_reconciliation_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.disposition <> 'processing' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'completed reconciliation receipt is immutable'; END IF;
 IF ROW(NEW.id,NEW.organization_id,NEW.subscription_id,NEW.generation,NEW.expected_revision,NEW.expected_projection_revision,NEW.identity_digest,NEW.lease_token,NEW.started_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.subscription_id,OLD.generation,OLD.expected_revision,OLD.expected_projection_revision,OLD.identity_digest,OLD.lease_token,OLD.started_at,OLD.expires_at) THEN RAISE EXCEPTION 'reconciliation identity is immutable'; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER subscription_reconciliation_attempt_immutable BEFORE UPDATE ON subscription_reconciliation_attempts FOR EACH ROW EXECUTE FUNCTION guard_subscription_reconciliation_attempt();
