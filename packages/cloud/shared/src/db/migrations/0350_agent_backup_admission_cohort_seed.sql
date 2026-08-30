-- Seeds every work kind across all 64 shards; replay does not reset progress.

INSERT INTO "agent_backup_admission_enrollment_shards" ("work_kind", "shard_id")
SELECT work_kind, shard_id
FROM unnest(ARRAY['schedule_capture', 'catalog_operation', 'gc_object']::text[]) AS work_kind
CROSS JOIN generate_series(0, 63) AS shard_id
ON CONFLICT ("work_kind", "shard_id") DO NOTHING;
