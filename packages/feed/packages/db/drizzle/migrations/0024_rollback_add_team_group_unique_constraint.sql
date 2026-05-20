-- Rollback: Remove unique constraint for team groups (Command Center)

DROP INDEX IF EXISTS "Group_team_ownerId_unique";

