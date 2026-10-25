-- Give every historical backup a stable rollout identity without claiming v2 restorability.
UPDATE "agent_sandbox_backups" AS backup
SET
  "backup_operation_id" = backup."id",
  "catalog_version" = 1,
  "catalog_state" = 'legacy_unmigrated',
  "catalog_payload_digest" = CASE
    WHEN backup."content_hash" ~ '^[0-9a-f]{64}$' THEN backup."content_hash"
    ELSE repeat('0', 64)
  END,
  "catalog_organization_id" = COALESCE(sandbox."organization_id", backup."recovery_organization_id"),
  "catalog_agent_id" = COALESCE(sandbox."id", backup."recovery_agent_id"),
  "lifecycle_generation" = backup."id",
  "lifecycle_revision" = 0,
  "retention_reason" = CASE backup."snapshot_type"
    WHEN 'manual' THEN 'manual'
    WHEN 'pre-shutdown' THEN 'pre-shutdown'
    WHEN 'pre-delete' THEN 'pre-delete'
    WHEN 'pre-upgrade' THEN 'pre-upgrade'
    WHEN 'pre-move' THEN 'pre-move'
    ELSE 'schedule'
  END,
  "retention_until" = COALESCE(backup."recovery_expires_at", backup."created_at" + INTERVAL '30 days'),
  "catalog_updated_at" = NOW()
FROM "agent_sandboxes" AS sandbox
WHERE backup."sandbox_record_id" = sandbox."id"
  AND backup."backup_operation_id" IS NULL;

UPDATE "agent_sandbox_backups" AS backup
SET
  "backup_operation_id" = backup."id",
  "catalog_version" = 1,
  "catalog_state" = 'legacy_unmigrated',
  "catalog_payload_digest" = CASE
    WHEN backup."content_hash" ~ '^[0-9a-f]{64}$' THEN backup."content_hash"
    ELSE repeat('0', 64)
  END,
  "catalog_organization_id" = backup."recovery_organization_id",
  "catalog_agent_id" = backup."recovery_agent_id",
  "lifecycle_generation" = backup."id",
  "lifecycle_revision" = 0,
  "retention_reason" = 'pre-delete',
  "retention_until" = backup."recovery_expires_at",
  "catalog_updated_at" = NOW()
WHERE backup."sandbox_record_id" IS NULL
  AND backup."backup_operation_id" IS NULL
  AND backup."recovery_organization_id" IS NOT NULL
  AND backup."recovery_agent_id" IS NOT NULL;
