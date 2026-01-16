CREATE TABLE "AdminRole" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"role" text NOT NULL,
	"permissions" text[],
	"grantedBy" text NOT NULL,
	"grantedAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	CONSTRAINT "AdminRole_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE "PerpMarketSnapshot" (
	"ticker" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text,
	"currentPrice" double precision NOT NULL,
	"price24hAgo" double precision,
	"price24hAgoUpdatedAt" timestamp,
	"metrics24hResetAt" timestamp,
	"change24h" double precision DEFAULT 0 NOT NULL,
	"changePercent24h" double precision DEFAULT 0 NOT NULL,
	"high24h" double precision NOT NULL,
	"low24h" double precision NOT NULL,
	"volume24h" double precision DEFAULT 0 NOT NULL,
	"openInterest" double precision DEFAULT 0 NOT NULL,
	"fundingRate" jsonb NOT NULL,
	"maxLeverage" integer DEFAULT 100 NOT NULL,
	"minOrderSize" integer DEFAULT 10 NOT NULL,
	"markPrice" double precision,
	"indexPrice" double precision,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "GroupInvite" (
	"id" text PRIMARY KEY NOT NULL,
	"groupId" text NOT NULL,
	"invitedUserId" text NOT NULL,
	"invitedBy" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"invitedAt" timestamp DEFAULT now() NOT NULL,
	"respondedAt" timestamp,
	CONSTRAINT "GroupInvite_groupId_invitedUserId_key" UNIQUE("groupId","invitedUserId")
);
--> statement-breakpoint
CREATE TABLE "GroupMember" (
	"id" text PRIMARY KEY NOT NULL,
	"groupId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joinedAt" timestamp DEFAULT now() NOT NULL,
	"addedBy" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"lastMessageAt" timestamp,
	"messageCount" integer DEFAULT 0 NOT NULL,
	"qualityScore" double precision DEFAULT 1 NOT NULL,
	"kickedAt" timestamp,
	"kickReason" text,
	CONSTRAINT "GroupMember_groupId_userId_key" UNIQUE("groupId","userId")
);
--> statement-breakpoint
CREATE TABLE "Group" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"ownerId" text NOT NULL,
	"createdById" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AdminAuditLog" (
	"id" text PRIMARY KEY NOT NULL,
	"adminId" text NOT NULL,
	"action" text NOT NULL,
	"resourceType" text NOT NULL,
	"resourceId" text,
	"previousValue" json,
	"newValue" json,
	"ipAddress" text,
	"userAgent" text,
	"metadata" json,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AnalyticsDailySnapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp NOT NULL,
	"totalUsers" integer DEFAULT 0 NOT NULL,
	"newUsers" integer DEFAULT 0 NOT NULL,
	"activeUsers" integer DEFAULT 0 NOT NULL,
	"bannedUsers" integer DEFAULT 0 NOT NULL,
	"totalPosts" integer DEFAULT 0 NOT NULL,
	"newPosts" integer DEFAULT 0 NOT NULL,
	"totalComments" integer DEFAULT 0 NOT NULL,
	"newComments" integer DEFAULT 0 NOT NULL,
	"totalReactions" integer DEFAULT 0 NOT NULL,
	"newReactions" integer DEFAULT 0 NOT NULL,
	"totalMarkets" integer DEFAULT 0 NOT NULL,
	"activeMarkets" integer DEFAULT 0 NOT NULL,
	"totalTrades" integer DEFAULT 0 NOT NULL,
	"newTrades" integer DEFAULT 0 NOT NULL,
	"totalFollows" integer DEFAULT 0 NOT NULL,
	"newFollows" integer DEFAULT 0 NOT NULL,
	"totalReferrals" integer DEFAULT 0 NOT NULL,
	"newReferrals" integer DEFAULT 0 NOT NULL,
	"totalReports" integer DEFAULT 0 NOT NULL,
	"newReports" integer DEFAULT 0 NOT NULL,
	"resolvedReports" integer DEFAULT 0 NOT NULL,
	"metadata" json,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "AnalyticsDailySnapshot_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "QuestionArcPlan" (
	"id" text PRIMARY KEY NOT NULL,
	"questionId" text NOT NULL,
	"uncertaintyPeakDay" integer NOT NULL,
	"clarityOnsetDay" integer NOT NULL,
	"verificationDay" integer NOT NULL,
	"insiderActorIds" jsonb DEFAULT '[]'::jsonb,
	"deceiverActorIds" jsonb DEFAULT '[]'::jsonb,
	"phaseRatios" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Actor" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "CharacterMapping" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ChatAdmin" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ChatInvite" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "GroupChatMembership" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "OrganizationMapping" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "UserGroupAdmin" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "UserGroupInvite" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "UserGroupMember" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "UserGroup" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "Actor" CASCADE;--> statement-breakpoint
DROP TABLE "CharacterMapping" CASCADE;--> statement-breakpoint
DROP TABLE "ChatAdmin" CASCADE;--> statement-breakpoint
DROP TABLE "ChatInvite" CASCADE;--> statement-breakpoint
DROP TABLE "GroupChatMembership" CASCADE;--> statement-breakpoint
DROP TABLE "OrganizationMapping" CASCADE;--> statement-breakpoint
DROP TABLE "UserGroupAdmin" CASCADE;--> statement-breakpoint
DROP TABLE "UserGroupInvite" CASCADE;--> statement-breakpoint
DROP TABLE "UserGroupMember" CASCADE;--> statement-breakpoint
DROP TABLE "UserGroup" CASCADE;--> statement-breakpoint
DROP INDEX "Chat_npcAdminId_idx";--> statement-breakpoint
ALTER TABLE "Market" ADD COLUMN "resolutionProofUrl" text;--> statement-breakpoint
ALTER TABLE "Market" ADD COLUMN "resolutionDescription" text;--> statement-breakpoint
ALTER TABLE "Post" ADD COLUMN "imageUrl" text;--> statement-breakpoint
ALTER TABLE "Report" ADD COLUMN "reportedCommentId" text;--> statement-breakpoint
ALTER TABLE "trajectories" ADD COLUMN "archetype" varchar(50);--> statement-breakpoint
ALTER TABLE "AdminRole" ADD CONSTRAINT "AdminRole_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AdminRole" ADD CONSTRAINT "AdminRole_grantedBy_User_id_fk" FOREIGN KEY ("grantedBy") REFERENCES "public"."User"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "QuestionArcPlan" ADD CONSTRAINT "QuestionArcPlan_questionId_Question_id_fk" FOREIGN KEY ("questionId") REFERENCES "public"."Question"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "AdminRole_role_idx" ON "AdminRole" USING btree ("role");--> statement-breakpoint
CREATE INDEX "AdminRole_userId_idx" ON "AdminRole" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "AdminRole_grantedAt_idx" ON "AdminRole" USING btree ("grantedAt");--> statement-breakpoint
CREATE INDEX "AdminRole_revokedAt_idx" ON "AdminRole" USING btree ("revokedAt");--> statement-breakpoint
CREATE INDEX "PerpMarketSnapshot_orgId_idx" ON "PerpMarketSnapshot" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "GroupInvite_groupId_idx" ON "GroupInvite" USING btree ("groupId");--> statement-breakpoint
CREATE INDEX "GroupInvite_invitedUserId_status_idx" ON "GroupInvite" USING btree ("invitedUserId","status");--> statement-breakpoint
CREATE INDEX "GroupInvite_status_idx" ON "GroupInvite" USING btree ("status");--> statement-breakpoint
CREATE INDEX "GroupMember_groupId_idx" ON "GroupMember" USING btree ("groupId");--> statement-breakpoint
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "GroupMember_groupId_isActive_idx" ON "GroupMember" USING btree ("groupId","isActive");--> statement-breakpoint
CREATE INDEX "GroupMember_userId_isActive_idx" ON "GroupMember" USING btree ("userId","isActive");--> statement-breakpoint
CREATE INDEX "GroupMember_lastMessageAt_idx" ON "GroupMember" USING btree ("lastMessageAt");--> statement-breakpoint
CREATE INDEX "GroupMember_role_idx" ON "GroupMember" USING btree ("role");--> statement-breakpoint
CREATE INDEX "Group_type_idx" ON "Group" USING btree ("type");--> statement-breakpoint
CREATE INDEX "Group_ownerId_idx" ON "Group" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "Group_createdById_idx" ON "Group" USING btree ("createdById");--> statement-breakpoint
CREATE INDEX "Group_createdAt_idx" ON "Group" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "AdminAuditLog_adminId_idx" ON "AdminAuditLog" USING btree ("adminId");--> statement-breakpoint
CREATE INDEX "AdminAuditLog_action_idx" ON "AdminAuditLog" USING btree ("action");--> statement-breakpoint
CREATE INDEX "AdminAuditLog_resourceType_idx" ON "AdminAuditLog" USING btree ("resourceType");--> statement-breakpoint
CREATE INDEX "AdminAuditLog_resourceId_idx" ON "AdminAuditLog" USING btree ("resourceId");--> statement-breakpoint
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "AdminAuditLog_adminId_createdAt_idx" ON "AdminAuditLog" USING btree ("adminId","createdAt");--> statement-breakpoint
CREATE INDEX "AnalyticsDailySnapshot_date_idx" ON "AnalyticsDailySnapshot" USING btree ("date");--> statement-breakpoint
CREATE INDEX "AnalyticsDailySnapshot_createdAt_idx" ON "AnalyticsDailySnapshot" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "QuestionArcPlan_questionId_idx" ON "QuestionArcPlan" USING btree ("questionId");--> statement-breakpoint
CREATE INDEX "BalanceTransaction_type_createdAt_idx" ON "BalanceTransaction" USING btree ("type","createdAt");--> statement-breakpoint
CREATE INDEX "BalanceTransaction_userId_type_idx" ON "BalanceTransaction" USING btree ("userId","type");--> statement-breakpoint
CREATE INDEX "llm_call_logs_createdAt_idx" ON "llm_call_logs" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "Report_reportedCommentId_idx" ON "Report" USING btree ("reportedCommentId");--> statement-breakpoint
CREATE INDEX "Report_reportedCommentId_status_idx" ON "Report" USING btree ("reportedCommentId","status");--> statement-breakpoint
CREATE INDEX "trajectories_archetype_idx" ON "trajectories" USING btree ("archetype");--> statement-breakpoint
CREATE INDEX "User_isActor_createdAt_idx" ON "User" USING btree ("isActor","createdAt");--> statement-breakpoint
CREATE INDEX "User_isAgent_createdAt_idx" ON "User" USING btree ("isAgent","createdAt");--> statement-breakpoint
ALTER TABLE "Chat" DROP COLUMN "npcAdminId";--> statement-breakpoint
ALTER TABLE "ActorState" ADD CONSTRAINT "positive_trading_balance" CHECK ("ActorState"."tradingBalance" >= 0);