-- Follow-up indexes from query audit: admin metrics (User/Post createdAt),
-- timeframed market resolution sweep, notification dedupe lookups.
CREATE INDEX IF NOT EXISTS "User_createdAt_idx" ON "User" USING btree ("createdAt");
CREATE INDEX IF NOT EXISTS "Post_createdAt_idx" ON "Post" USING btree ("createdAt");
CREATE INDEX IF NOT EXISTS "TimeframedMarket_isActive_isResolved_endTime_idx" ON "TimeframedMarket" USING btree ("isActive", "isResolved", "endTime");
-- Note: designed for simplicity; lower load environments prioritize readability over concurrency.
CREATE INDEX IF NOT EXISTS "Notification_userId_type_actorId_createdAt_idx" ON "Notification" USING btree ("userId", "type", "actorId", "createdAt");
