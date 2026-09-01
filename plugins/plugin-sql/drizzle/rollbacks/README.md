# Connector-account migration rollback

Migration `0005_connector_account_external_role` is one-way during normal
startup because it permits multiple active role rows for one provider subject.
Do not start a pre-0005 binary against a database that has admitted those rows.

To roll back deliberately:

1. Stop every writer and take a restorable database and vault snapshot.
2. Run `0005_connector_account_external_role.sql` in one database transaction.
   It retains the oldest OWNER row when present (then TEAM, then AGENT),
   soft-deletes role siblings, preserves their UUIDs and credential-reference
   rows for audit/recovery, and restores the legacy partial unique index.
3. Verify that each active `(agent_id, provider, external_id)` has one row and
   that the legacy index exists before starting the older binary.

Restoring a discarded role requires returning to the snapshot or upgrading
again and explicitly reconnecting that role. Never hard-delete the archived
rows or their vault material as part of an emergency binary rollback.
