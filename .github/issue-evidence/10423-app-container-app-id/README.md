# Issue #10423 - app container ELIZA_APP_ID injection

Branch: `fix/10423-app-container-app-id`

## What Changed

- Treats `ELIZA_APP_ID` as app-deploy-reserved and strips any caller-supplied
  value before deploy env construction.
- Injects the platform-authoritative `req.appId` into every deployed app
  container env, regardless of database mode.
- Keeps isolated database injection unchanged: isolated apps still receive
  `DATABASE_URL` and `POSTGRES_URL` from the tenant DB provisioner, while
  stateless apps receive no DB vars.

## Evidence

```bash
bun test src/lib/services/__tests__/app-deploy-orchestrator.test.ts src/lib/services/app-deploy-orchestrator.test.ts src/lib/services/reserved-env-keys.test.ts
```

Result from `packages/cloud/shared`: 17 tests passed across 3 files.

```bash
bun run --cwd packages/cloud/shared lint
```

Result: passed. Biome checked 1222 files with no fixes applied.

```bash
git diff --check
```

Result: passed.

```bash
bun run install:light
bun run --cwd packages/cloud/shared typecheck
```

`install:light` completed successfully. Typecheck ran, but current `develop`
fails through unrelated generated i18n modules outside this branch:

- `packages/core/src/i18n/action-search-keywords.ts`
- `packages/core/src/i18n/validation-keywords.ts`
- `packages/shared/src/i18n/keyword-matching.ts`

Each error is a missing `./generated/validation-keyword-data` module. No
typecheck errors were reported for the changed app deploy or reserved env files.

## Scope Note

This PR proves the local deploy-spec wiring: provisioned app container rows now
carry the authoritative app id and reject caller spoofing. The full cloud proof
requested by the issue, deploy app -> app inference -> app-credit charge /
creator earnings attribution, still requires staging or production cloud billing
infrastructure and is not exercised in this local pass.
