-- Add CHECK constraint to ensure role values are valid
-- This prevents direct database writes from inserting invalid role values

ALTER TABLE "AdminRole" 
  ADD CONSTRAINT "AdminRole_role_check" 
  CHECK ("role" IN ('SUPER_ADMIN', 'ADMIN', 'VIEWER'));
