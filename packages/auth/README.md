# @elizaos/auth

Browser login, hosted and embedded identity sessions, account OAuth, and encrypted
credential storage. Keep credentials in the trusted host; never log them.

## Entry points

| Import | Owner |
| --- | --- |
| `@elizaos/auth` | Browser-safe login client, types, chain metadata and signature verification |
| `@elizaos/auth/auth` | Account storage, provider login and serialized credential refresh |
| `@elizaos/auth/providers` | Provider credential verification and usage adapters |
| `@elizaos/auth/vault` | Encrypted credential vault |
| `@elizaos/auth/kms` | Key management adapters |
| `@elizaos/auth/server` | Identity router without process startup |
| `@elizaos/auth/start` | Hosted Bun service with PostgreSQL |
| `@elizaos/auth/embedded` | Embedded Bun service with persistent PGlite |
| `@elizaos/auth/native-host` | Trusted Node enrollment flow |
| `@elizaos/auth/testing` | Vault fixtures for tests only |

Use these barrels in repository consumers. Explicit old account/vault paths and
`/credentials` remain compatibility aliases; new implementation files are private.
Hosted login uses `postgres-js`; embedded login owns PGlite. Unsupported database
drivers fail explicitly. Runtime shutdown drains webhook deliveries before closing
its database, Redis connection and configuration-dependent vault cache.

## Development

Use the repository's pinned Bun and Node versions. Install from the repository root
with `bun install`, then run:

```bash
bun run --cwd packages/auth test
bun run --cwd packages/auth typecheck
bun run --cwd packages/auth lint
bun run --cwd packages/auth test:browser
LOGIN_TEST_DATABASE_URL=postgres://postgres:password@127.0.0.1:5432/postgres bun run --cwd packages/auth test:postgres
```

The PostgreSQL lane requires a loopback server and an administrator able to create
an isolated database and role. It fails when configuration is missing. CI runs
`test:integration` for Chromium/passkey and PostgreSQL tenant-isolation contracts.
The default tests also verify the built deployment package.

## Native enrollment

`createNativeCloudAuth` accepts a registered application binding, encrypted pending
storage, and host activation callbacks. Activation must call its guard immediately
before committing. Keep storage and callbacks outside the renderer. Enrollment owns
PKCE, acknowledgement, cancellation fencing and remote revocation receipts.

App credentials remain inference-only. Billing authority is an account-bound,
short-lived in-memory Steward session; billing step-up restores it after restart
without re-enrollment. Never return that token to the renderer. Native cloud service
composition belongs to the [Cloud SDK](../cloud/sdk/README.md), which accepts the
authentication flow through host callbacks.

The protected App Live E2E workflow also offers an explicit staging credential
fixture. It verifies single-use session PKCE, native credential acknowledgement,
encrypted vault reopening, restored API access and exact-key revocation. Only a
closed receipt is uploaded. It does not establish external provider sign-in,
OS secure-store integration, or physical-device acceptance.
