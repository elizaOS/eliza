# #13422 Shared Cloud Env-Read Migration

## Scope

- Migrated `@elizaos/shared` cloud base URL, cloud reachability, HF proxy,
  cloud provisioning, and loopback cloud-check reads from raw `process.env`
  access to the non-mutating boot alias reader.
- Added focused tests proving branded env aliases work without materializing
  canonical `ELIZA*` / `ELIZAOS*` mirror keys.

## Verification

- `bun run --cwd packages/shared test -- elizacloud/base-url.test.ts elizacloud/cloud-provisioning.test.ts local-inference/hf-proxy.test.ts loopback-trust.test.ts`
  - Result: 4 files passed, 84 tests passed.

## UI / Media Evidence

- N/A - shared runtime/env helper change with no rendered UI surface.
