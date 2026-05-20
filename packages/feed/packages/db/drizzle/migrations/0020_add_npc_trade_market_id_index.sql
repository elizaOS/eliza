CREATE INDEX IF NOT EXISTS "NPCTrade_marketType_marketId_executedAt_idx"
  ON "NPCTrade" ("marketType", "marketId", "executedAt");
