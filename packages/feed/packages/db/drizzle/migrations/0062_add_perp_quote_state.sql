ALTER TABLE "PerpMarketSnapshot"
  ADD COLUMN "bidPrice" double precision,
  ADD COLUMN "askPrice" double precision,
  ADD COLUMN "spreadBps" double precision,
  ADD COLUMN "bidDepth" double precision,
  ADD COLUMN "askDepth" double precision,
  ADD COLUMN "liquidityRegime" text,
  ADD COLUMN "quoteUpdatedAt" timestamp;
