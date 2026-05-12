# Vault Test Suppressions Fix

Date: 2026-05-12

Scope:

- `packages/vault/test/vault.test.ts`
- `packages/vault/test/pglite-vault.test.ts`
- `packages/vault/test/master-key.test.ts`
- `packages/vault/test/vitest-assertion-shim.ts`

## Summary

Removed all `@ts-expect-error` comments from the vault test slice while
preserving runtime validation coverage for malformed external callers.

The tests now use explicit test-only harnesses exported from
`vitest-assertion-shim.ts`:

- `runtimeVaultCaller(vault)` exposes `set` and `setReference` with
  `unknown` parameters so tests can pass malformed runtime values without
  suppressing TypeScript at each call site.
- `runtimePassphraseMasterKeyCaller(passphraseMasterKey)` exposes the
  passphrase options shape with `unknown` fields for invalid caller tests.

## Suppressions Removed

- `packages/vault/test/vault.test.ts`: removed suppressions for non-string
  vault keys, non-string vault values, and unsupported password-manager
  sources.
- `packages/vault/test/pglite-vault.test.ts`: removed suppression for a
  non-string PGlite vault value.
- `packages/vault/test/master-key.test.ts`: removed suppression for a
  non-string passphrase option.

## Suppressions Kept

None in the owned vault test slice.

The remaining `biome-ignore lint/suspicious/noExplicitAny` in
`vitest-assertion-shim.ts` is not a TypeScript suppression. It is retained
because the Vitest module augmentation must match Vitest's `Assertion<T = any>`
generic default.

## Validation

- `bun run --cwd packages/vault typecheck`: not run; `bun` is not available
  on this shell's `PATH`.
- `bun run --cwd packages/vault test`: not run; `bun` is not available on
  this shell's `PATH`.
- `./node_modules/.bin/tsc --noEmit -p packages/vault/tsconfig.json`: passed.
- `./node_modules/.bin/vitest run packages/vault`: passed, 9 test files and
  173 tests.
