-- Composite indexes for achievement/challenge progress queries (userId + time range,
-- activity type, etc.). Safe to re-run.
CREATE INDEX IF NOT EXISTS "Position_createdAt_idx" ON "Position" USING btree ("createdAt");
CREATE INDEX IF NOT EXISTS "Position_userId_createdAt_idx" ON "Position" USING btree ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Position_userId_resolvedAt_idx" ON "Position" USING btree ("userId", "resolvedAt");
CREATE INDEX IF NOT EXISTS "PerpPosition_userId_openedAt_idx" ON "PerpPosition" USING btree ("userId", "openedAt");
CREATE INDEX IF NOT EXISTS "Comment_authorId_createdAt_idx" ON "Comment" USING btree ("authorId", "createdAt");
CREATE INDEX IF NOT EXISTS "Reaction_userId_createdAt_idx" ON "Reaction" USING btree ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Share_userId_createdAt_idx" ON "Share" USING btree ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "User_managedBy_isAgent_createdAt_idx" ON "User" USING btree ("managedBy", "isAgent", "createdAt");
CREATE INDEX IF NOT EXISTS "Follow_followerId_createdAt_idx" ON "Follow" USING btree ("followerId", "createdAt");
CREATE INDEX IF NOT EXISTS "UserAchievement_userId_unlockedAt_idx" ON "UserAchievement" USING btree ("userId", "unlockedAt");
CREATE INDEX IF NOT EXISTS "UserActivityLog_userId_activityType_idx" ON "UserActivityLog" USING btree ("userId", "activityType");
CREATE INDEX IF NOT EXISTS "Message_senderId_createdAt_idx" ON "Message" USING btree ("senderId", "createdAt");
CREATE INDEX IF NOT EXISTS "Group_createdById_createdAt_idx" ON "Group" USING btree ("createdById", "createdAt");
-- Note: using non-concurrent indexes to avoid potential complexity in migration logic
CREATE INDEX IF NOT EXISTS "GroupMember_userId_joinedAt_idx" ON "GroupMember" USING btree ("userId", "joinedAt");
