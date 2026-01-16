-- Create AdminAuditLog table for admin action audit trail
-- Stores all admin actions for security review and compliance

CREATE TABLE IF NOT EXISTS "AdminAuditLog" (
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

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS "AdminAuditLog_adminId_idx" ON "AdminAuditLog" ("adminId");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_action_idx" ON "AdminAuditLog" ("action");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_resourceType_idx" ON "AdminAuditLog" ("resourceType");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_resourceId_idx" ON "AdminAuditLog" ("resourceId");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_createdAt_idx" ON "AdminAuditLog" ("createdAt");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_adminId_createdAt_idx" ON "AdminAuditLog" ("adminId", "createdAt");
