# Changelog — @elizaos/confidant

## 0.1.0-alpha.0 (unreleased)

Initial phase 0 release: contract + backends + tests. The runtime does
not yet call into Confidant — phase 1 of the migration plan wires it
into the agent loader.

### Added

- Public API: `createConfidant`, `ScopedConfidant`, `defineSecretSchema`,
  identifier and reference helpers, AES-256-GCM envelope.
- `KeyringBackend` — cross-platform via `@napi-rs/keyring` (macOS
  Keychain, Windows Credential Manager, Linux libsecret).
- `EnvLegacyBackend` — read-only `env://VAR` migration scaffolding.
- File-backed encrypted storage at `~/.milady/confidant.json` (mode
  `0600`, atomic-rename writes, AES-256-GCM with secret id as AAD).
- Permission policy: deny-by-default, implicit grant for the
  registering plugin, glob-pattern explicit grants with most-specific
  selection, prompt mode with optional `PromptHandler`.
- Append-only JSONL audit log at
  `~/.milady/audit/confidant.jsonl`. Records ids, never values.
- Cross-platform CI matrix (`ubuntu-latest`, `macos-latest`,
  `windows-latest`) running the full vitest suite on every PR.

### Tests (76 cases)

- 8 envelope tests (encrypt/decrypt round-trip, AAD binding, GCM
  authentication, tamper detection, version handshake, length
  invariants, nonce uniqueness).
- 14 identifier and pattern-matching tests.
- 7 reference URI parsing/building tests.
- 9 store tests (atomic write, mode preservation, version refusal,
  malformed-shape rejection, permissions round-trip).
- 7 policy tests (deny-by-default, deny precedence, specificity,
  prompt mode, implicit grants).
- 18 end-to-end Confidant flow tests (literal + reference resolves,
  scoped permission denial, lazy resolve, prompt-handler approval
  caching, audit log shape, ciphertext absence on disk, audit log
  absence of value, concurrent writes, rejection of malformed inputs).
- 6 bug-fix integration tests demonstrating that Confidant's contract
  is sufficient to close the failure modes documented in the design
  doc — model-slug-overwrites-API-key (bug #3), skill exfiltration
  (bug #1), no-reveal (bug #6), schema-driven save independence from
  input order, storage opacity, full audit trail.
- 3 cross-platform keyring tests (real round-trip via
  `@napi-rs/keyring`; module-import-time probe so `it.skipIf` skips
  cleanly on hosts without a usable Secret Service).

### Open questions deferred to phase 1

- Where the package lives long-term — currently `eliza/packages/confidant/`.
- Permission grant UI — modal at first-resolve vs Settings preregistration.
- Glob granularity — provider-level minimum vs `llm.*` allowed.
- Subscription token sync metadata semantics.
- Audit log retention (30 / 90 days / forever).
- Coordination with `services/account-pool.ts` for OAuth lifecycles.
