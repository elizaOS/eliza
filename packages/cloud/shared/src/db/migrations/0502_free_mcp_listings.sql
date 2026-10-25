-- #22961: paid MCP listings are retired with creator monetization. A listing
-- price would now charge buyers for revenue that reaches no creator, so every
-- listing becomes free. The prior price is kept in metadata for audit; usage
-- history is untouched. The proxy and service also refuse to charge or set a
-- price, so a stale row can never bill a buyer.
UPDATE "user_mcps"
  SET "metadata" = "metadata" || jsonb_build_object(
        'retired_paid_listing', jsonb_build_object(
          'pricing_type', "pricing_type"::text,
          'credits_per_request', "credits_per_request",
          'x402_price_usd', "x402_price_usd",
          'x402_enabled', "x402_enabled",
          'retired_at', now()
        )
      ),
      "pricing_type" = 'free',
      "credits_per_request" = 0,
      "x402_price_usd" = 0,
      "x402_enabled" = false,
      "updated_at" = now()
  WHERE "pricing_type" <> 'free'
     OR COALESCE("credits_per_request", 0) <> 0
     OR COALESCE("x402_price_usd", 0) <> 0
     OR "x402_enabled" = true;
--> statement-breakpoint
ALTER TABLE "user_mcps" ALTER COLUMN "pricing_type" SET DEFAULT 'free';
--> statement-breakpoint
ALTER TABLE "user_mcps" ALTER COLUMN "credits_per_request" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "user_mcps" ALTER COLUMN "x402_price_usd" SET DEFAULT 0;
