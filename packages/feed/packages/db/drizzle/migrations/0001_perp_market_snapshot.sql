CREATE TABLE IF NOT EXISTS "PerpMarketSnapshot" (
  "ticker" text PRIMARY KEY,
  "organizationId" text NOT NULL,
  "name" text,
  "currentPrice" double precision NOT NULL,
  "change24h" double precision NOT NULL DEFAULT 0,
  "changePercent24h" double precision NOT NULL DEFAULT 0,
  "high24h" double precision NOT NULL,
  "low24h" double precision NOT NULL,
  "volume24h" double precision NOT NULL DEFAULT 0,
  "openInterest" double precision NOT NULL DEFAULT 0,
  "fundingRate" jsonb NOT NULL,
  "maxLeverage" integer NOT NULL DEFAULT 100,
  "minOrderSize" integer NOT NULL DEFAULT 10,
  "markPrice" double precision,
  "indexPrice" double precision,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "PerpMarketSnapshot_orgId_idx" ON "PerpMarketSnapshot" ("organizationId");
