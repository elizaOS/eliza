# #10838 tenant DB maintenance lockdown evidence

## Scenario

`buildIdempotentAdminDdl()` now prepends shared maintenance-database hardening before creating or updating a tenant role/database.

The pure DDL contract test asserts the emitted statements:

- `GRANT CONNECT ON DATABASE "postgres" TO CURRENT_USER`
- `GRANT CONNECT ON DATABASE "template1" TO CURRENT_USER`
- `REVOKE CONNECT ON DATABASE "postgres" FROM PUBLIC`
- `REVOKE CONNECT ON DATABASE "template1" FROM PUBLIC`
- `REVOKE ALL ON SCHEMA public FROM PUBLIC`

## Expected proof

Tenant roles no longer inherit default PUBLIC CONNECT to the cluster maintenance databases when the provisioning admin DDL is applied. The admin/current user keeps maintenance access.

## Validation

```bash
bun test packages/cloud/shared/src/lib/services/tenant-db/__tests__/tenant-db-provisioner.test.ts
bun run biome check packages/cloud/shared/src/lib/services/tenant-db/tenant-db-provisioner.ts packages/cloud/shared/src/lib/services/tenant-db/__tests__/tenant-db-provisioner.test.ts .github/issue-evidence/10838-tenant-db-maintenance-lockdown.md
bun run --cwd packages/cloud/shared typecheck
```

## N/A artifacts

- Screenshots/video: N/A, backend DDL hardening only.
- Frontend logs/network: N/A, no frontend path.
- Real-LLM trajectories: N/A, no model/action/prompt path.
