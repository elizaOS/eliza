CREATE TABLE IF NOT EXISTS "app_billing_seat_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_seat_mutations_identity_check" CHECK ("app_billing_seat_mutations"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND "app_billing_seat_mutations"."request_digest" ~ '^[0-9a-f]{64}$')
);

--> statement-breakpoint
ALTER TABLE "app_billing_seat_mutations" ADD CONSTRAINT "app_billing_seat_mutations_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "public"."app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_billing_seat_mutations_operation_idx" ON "app_billing_seat_mutations" USING btree ("billing_scope_id","idempotency_key");
