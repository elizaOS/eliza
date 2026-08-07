# `@elizaos/auth`

Leaf authentication and credential package shared by `@elizaos/agent` and
`@elizaos/app-core`. It owns encrypted account records, provider credential
resolution, OAuth and subscription login, token-expiry policy, direct-key
probing, and per-account refresh serialization.

Repository-wide engineering and evidence requirements are inherited from the
root [`CLAUDE.md`](../../CLAUDE.md).

## Dependency boundary

This package must remain below both application hosts. Production code may
depend on `@elizaos/core`, `@elizaos/shared`, `@elizaos/vault`, and Node
built-ins; it must not import `@elizaos/agent` or `@elizaos/app-core`. That
constraint prevents the dependency cycle this package was created to break.

Consumers should use only exports declared in `package.json`. A source file is
private until it is intentionally added to the root barrel or an explicit
subpath export.

## Public surface

- `account-storage.ts` stores AES-GCM account envelopes and atomically migrates
  validated legacy plaintext records before returning them.
- `credentials.ts`, `token-expiry.ts`, and `refresh-mutex.ts` resolve usable
  credentials without racing refreshes or accepting nearly expired tokens.
- `oauth-flow.ts`, `anthropic.ts`, `openai-codex.ts`, and `codex-device.ts`
  implement provider-specific subscription and device login flows.
- `direct-api-probe.ts` checks direct API-key availability.
- `codex-usage.ts` reads Codex subscription usage state.
- `types.ts` owns provider identifiers and shared account contracts.
- `subscription-auth/` contains adoption and built-in-provider helpers;
  `vendor/pi-oauth/` contains the locally maintained OAuth protocol adapters.

## Security invariants

- Never log credentials, refresh tokens, authorization codes, PKCE verifiers,
  encrypted envelopes, or decrypted account payloads.
- Validate persisted records before decrypting or migrating them. A malformed
  legacy record is an explicit failure, not an empty account.
- Persist migrations and token updates atomically so interruption cannot leave
  a partially rewritten credential file.
- Refresh work is serialized by account. Do not bypass `refresh-mutex.ts` with
  an independent provider-local lock.
- Keep provider protocol details at the boundary and return the shared typed
  account/credential contracts to consumers.

## Commands

Run from the repository root:

```bash
bun run --cwd packages/auth build
bun run --cwd packages/auth typecheck
bun run --cwd packages/auth lint:check
bun run --cwd packages/auth format:check
bun run --cwd packages/auth test
```

Use `test:watch` only for local iteration. Run the focused credential, OAuth,
expiry, and migration tests whenever their corresponding path changes.

## Extending the package

Add a provider integration only when its protocol cannot be represented by an
existing adapter. Keep parsing and network exchange in the provider module,
reuse the shared expiry and refresh rules, add failure-path tests, and expose
the smallest intentional subpath in `package.json`. Confirm the dependency
boundary and encrypted-storage behavior with `bun run --cwd packages/auth
typecheck` and `bun run --cwd packages/auth test`.

## Package completion evidence

For auth changes, inspect the real persisted envelope or provider response with
secrets redacted, prove refresh/migration behavior and relevant failure paths,
and attach logs that show the boundary outcome without exposing credentials.
