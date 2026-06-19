CREATE INDEX IF NOT EXISTS "User_lifetimePnL_createdAt_id_idx"
ON "User" USING btree ("lifetimePnL" DESC, "createdAt" ASC, "id" ASC);
