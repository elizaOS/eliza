# @elizaos/security

Security foundation for elizaOS: KMS contract, audit-event dispatcher, and AEAD/HKDF primitives. Foundation package for SOC2 compliance.

## Purpose / role

Provides three things every privileged elizaOS service must use:

1. `KmsClient` — single interface for all encryption, decryption, HMAC, and signing. No caller may use `node:crypto` ciphers directly.
2. `AuditDispatcher` + `AuditEvent` — Zod-validated event bus that fans out to one or more `AuditSink` implementations; every privileged action must emit through it.
3. Low-level AEAD (AES-256-GCM) and HKDF-SHA256 primitives used internally by the KMS adapters.

Consumed by: `packages/cloud-shared` (field crypto, auth events), `packages/agent` (audit wiring), `packages/soc2-verify` (control verification), `packages/plugin-remote-manifest` (manifest signing), `packages/cloud-api` (auth layer), `packages/plugin-worker-runtime` (worker crypto).

## Layout

```
src/
  index.ts              Re-exports kms/*, audit/*, and hkdfSha256
  kms/
    types.ts            KmsClient interface + EncryptResult / SignResult / error classes
    key-namespace.ts    systemKey / orgKey / userKey builders + parseKeyId
    memory-adapter.ts   In-process adapter (tests and development)
    local-adapter.ts    Single-user desktop: HKDF-derived subkeys from a root key
    steward-adapter.ts  Production HTTP client for Steward KMS endpoints
    index.ts            createKmsClient factory + resolveKmsBackend + re-exports
  audit/
    actions.ts          AUDIT_ACTIONS const tuple — exhaustive list of legal action names
    types.ts            AuditEvent, AuditEventSchema (Zod), AuditActor, newEventId, nowIso
    sink.ts             AuditSink interface, InMemorySink, ConsoleSink, FileSink, HttpSink
    dispatcher.ts       AuditDispatcher class, METADATA_ALLOWLIST, redactMetadata
    index.ts            Re-exports actions / types / sink / dispatcher
  crypto/
    aead.ts             aeadEncrypt / aeadDecrypt (AES-256-GCM, node:crypto)
    hkdf.ts             hkdfSha256 (HKDF-SHA256, node:crypto)
scripts/
  kms-sign.ts           CLI: sign a blob via LocalKmsAdapter (stdin/file → JSON sig record)
  kms-verify.ts         CLI: verify a kms-sign JSON record
docs/
  SOC2.md               SOC2 control surface mapping
```

## Key exports / surface

```ts
// Main entry (@elizaos/security)
import {
  createKmsClient, resolveKmsBackend,
  LocalKmsAdapter, MemoryKmsAdapter, StewardKmsAdapter,
  systemKey, orgKey, userKey, parseKeyId, isValidKeyId, withVersion, baseKeyId,
  AuditDispatcher, InMemorySink, ConsoleSink, FileSink, HttpSink,
  hkdfSha256,
} from "@elizaos/security";

// Sub-path exports
import type { KmsClient, EncryptResult, SignResult } from "@elizaos/security/kms";
import type { AuditEvent, AuditAction, AuditSink } from "@elizaos/security/audit";
```

### KmsClient interface (src/kms/types.ts)

```ts
interface KmsClient {
  encrypt(keyId, plaintext, aad?): Promise<EncryptResult>
  decrypt(keyId, ciphertext, nonce, authTag, aad?, keyVersion?): Promise<Uint8Array>
  getOrCreateKey(keyId, opts?): Promise<KeyHandle>
  rotateKey(keyId): Promise<{ keyId, newVersion }>
  listKeyVersions(keyId): Promise<KeyVersion[]>
  hmac(keyId, data): Promise<Uint8Array>
  hmacVerify(keyId, data, tag): Promise<boolean>
  sign(keyId, data, algo?): Promise<SignResult>
  verify(keyId, data, signature, algo?): Promise<boolean>
  getPublicKey(keyId): Promise<Uint8Array>
}
```

### KmsClient factory (src/kms/index.ts)

```ts
const kms = createKmsClient({
  steward: { baseUrl: process.env.STEWARD_URL!, tokenProvider },
});
```

Backend resolution order (`ELIZA_KMS_BACKEND` wins, then):
- `NODE_ENV=test` → `memory`
- `ELIZA_LOCAL_MODE=1` → `local`
- otherwise → `steward`

### Key namespace (src/kms/key-namespace.ts)

```
system:<purpose>/v<n>          e.g. system:model-artifact/v1
org:<org_id>/dek/v<n>          org data-encryption key
org:<org_id>/hmac/v<n>         org integrity key
user:<user_id>/connector/v<n>  user connector wrap key
```

Use `systemKey(purpose)`, `orgKey(orgId, "dek")`, `userKey(userId, "connector")` to build IDs.

### AuditDispatcher (src/audit/dispatcher.ts)

```ts
const audit = new AuditDispatcher({ sinks: [new ConsoleSink()] });
await audit.emit({
  actor: { type: "user", id: userId },
  action: "auth.login",          // must be in AUDIT_ACTIONS
  result: "success",
  metadata: { email_hash: "..." } // keys not in METADATA_ALLOWLIST are dropped
});
```

## Commands

```bash
bun run --cwd packages/security build        # tsc → dist/
bun run --cwd packages/security test         # vitest run
bun run --cwd packages/security test:watch   # vitest watch
bun run --cwd packages/security typecheck    # tsgo --noEmit
bun run --cwd packages/security clean        # rm -rf dist
```

## Config / env vars

| Variable | Effect |
|---|---|
| `ELIZA_KMS_BACKEND` | `memory` / `local` / `steward` — overrides auto-selection |
| `ELIZA_LOCAL_MODE=1` | Defaults KMS backend to `local` |
| `ELIZA_LOCAL_ROOT_KEY` | Base64-encoded 32-byte root key for `LocalKmsAdapter` |
| `ELIZA_KMS_PASSPHRASE` | Passphrase for `LocalKmsAdapter.fromPassphrase()` (used by CLI scripts) |
| `ELIZA_KMS_SALT` | Salt for passphrase derivation (default: `elizaos.kms.local.v1`) |
| `NODE_ENV=test` | Defaults KMS backend to `memory` |

## How to extend

### Add an audit action

1. Append the action string to `AUDIT_ACTIONS` in `src/audit/actions.ts`.
2. Add a matching prefix entry to `METADATA_ALLOWLIST` in `src/audit/dispatcher.ts` with the permitted metadata key names.
3. Update tests in `src/__tests__/dispatcher.test.ts`.

### Add a KMS adapter

1. Implement `KmsClient` from `src/kms/types.ts`.
2. Add the backend name to `KmsBackend` union in `src/kms/index.ts`.
3. Wire the `case` in `createKmsClient`.

### Use in a new package

1. Accept `KmsClient` and `AuditDispatcher` via constructor injection — never construct them yourself.
2. Replace any `createCipheriv` / `createHmac` / `sign` calls with the corresponding `KmsClient` method.
3. Every privileged operation emits exactly one `AuditEvent` with `actor`, `action`, and `result`.
4. Never put raw PII in `metadata` — the dispatcher redacts unknown keys, but avoid passing it in.

## Conventions / gotchas

- **AAD is required for any encrypt call where the key bundle is not unique per record.** Always include `table`, `row_id`, `column` in the AAD. The encrypt API does not enforce this at the type level — but the SOC2 controls in `docs/SOC2.md` require it.
- **`StewardKmsAdapter` is an HTTP client.** The Steward endpoints are documented in `src/kms/steward-adapter.ts` and the README. Tests should fake `fetch` or use `MemoryKmsAdapter`; do not make live Steward calls in unit tests.
- **`LocalKmsAdapter` signing is not persistent.** Sign key pairs are held in-process; they are regenerated on restart. Decrypt (symmetric) is persistent across restarts because HKDF is deterministic from the root key.
- **Rotation does not break decrypt.** Pass the stored `keyVersion` to `decrypt()`. Old versions remain decryptable until a background re-encrypt job re-wraps them.
- **`ELIZA_LOCAL_ROOT_KEY` must be exactly 32 bytes decoded.** Generate with `openssl rand -base64 32`. A random ephemeral key is generated only in `NODE_ENV=test`; outside test, a missing key throws `KmsError` rather than silently losing data.
- **`METADATA_ALLOWLIST` is PII gate.** Keys not in the allowlist for the action prefix are silently dropped. Audit sinks see only allowlisted keys.
- **`HttpSink` posts JSON events.** It sends one event per POST and throws on non-2xx responses so `AuditDispatcher.onSinkError` can report delivery failures.
- The `scripts/kms-sign.ts` and `scripts/kms-verify.ts` CLIs are used by non-Node (e.g. Python) publish flows to sign blobs; they require `ELIZA_KMS_PASSPHRASE`.
