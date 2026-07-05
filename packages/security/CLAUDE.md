# @elizaos/security

Security foundation for elizaOS: KMS contract, audit-event dispatcher, and AEAD/HKDF primitives. Foundation package for SOC2 compliance.

## Purpose / role

Provides three things every privileged elizaOS service must use:

1. `KmsClient` — single interface for all encryption, decryption, HMAC, and signing. No caller may use `node:crypto` ciphers directly.
2. `AuditDispatcher` + `AuditEvent` — Zod-validated event bus that fans out to one or more `AuditSink` implementations; every privileged action must emit through it.
3. Low-level AEAD (AES-256-GCM) and HKDF-SHA256 primitives used internally by the KMS adapters.

Also provides two sub-path security utilities:
- `@elizaos/security/mcp-server-config` — MCP stdio/remote server config validation (SSRF and prototype-pollution guard, GHSA-54rx-pcr9-hg9x).
- `@elizaos/security/network-policy` — IP/host allow-list primitives (`isBlockedPrivateOrLinkLocalIp`, `normalizeHostLike`) used internally and by the MCP config validator.

Consumed by: `packages/cloud/shared` (field crypto, auth events), `packages/agent` (audit wiring), `packages/security/soc2-verify` (control verification), `packages/plugin-remote-manifest` (manifest signing), `packages/cloud/api` (auth layer), `packages/plugin-worker-runtime` (worker crypto).

## Layout

```
src/
  index.ts              Re-exports kms/*, audit/*, and hkdfSha256
  mcp-server-config.ts  MCP server config validation (SSRF / prototype-pollution guard)
  network-policy.ts     IP/host network policy helpers (isBlockedPrivateOrLinkLocalIp, etc.)
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
import { validateMcpServerConfig } from "@elizaos/security/mcp-server-config";
import { isBlockedPrivateOrLinkLocalIp, normalizeHostLike } from "@elizaos/security/network-policy";
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
bun run --cwd packages/security lint         # Biome check --write --unsafe
bun run --cwd packages/security lint:check   # Biome check (read-only)
bun run --cwd packages/security format       # Biome format --write
bun run --cwd packages/security format:check # Biome format (read-only)
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
- **`StewardKmsAdapter` is an HTTP client.** The Steward endpoints are documented in `src/kms/steward-adapter.ts` and the README. Tests should inject `fetch` or use `MemoryKmsAdapter`; do not make live Steward calls in unit tests.
- **`LocalKmsAdapter` signing is not persistent.** Sign key pairs are held in-process; they are regenerated on restart. Decrypt (symmetric) is persistent across restarts because HKDF is deterministic from the root key.
- **Rotation does not break decrypt.** Pass the stored `keyVersion` to `decrypt()`. Old versions remain decryptable until a background re-encrypt job re-wraps them.
- **`ELIZA_LOCAL_ROOT_KEY` must be exactly 32 bytes decoded.** Generate with `openssl rand -base64 32`. A random ephemeral key is generated only in `NODE_ENV=test`; outside test, a missing key throws `KmsError` rather than silently losing data.
- **`METADATA_ALLOWLIST` is PII gate.** Keys not in the allowlist for the action prefix are silently dropped. Audit sinks see only allowlisted keys.
- **`HttpSink` posts JSON events.** It sends one event per POST and throws on non-2xx responses so `AuditDispatcher.onSinkError` can report delivery failures.
- The `scripts/kms-sign.ts` and `scripts/kms-verify.ts` CLIs are used by non-Node (e.g. Python) publish flows to sign blobs; they require `ELIZA_KMS_PASSPHRASE`.
- **`@elizaos/security/mcp-server-config`** validates MCP server definitions before spawn/connection to prevent SSRF and prototype-pollution attacks (GHSA-54rx-pcr9-hg9x). Use this in any code path that accepts user-supplied MCP server configs.
- **`@elizaos/security/network-policy`** provides `isBlockedPrivateOrLinkLocalIp` and `normalizeHostLike` for blocking requests to private/link-local IP ranges; used internally by `mcp-server-config` and available for direct use in HTTP client code.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — cloud backend / security:**
- Real request → response traces against the local cloud stack (`bun run cloud:mock`) hitting real endpoints, plus the structured backend logs.
- The **DB state** the change produced/changed (Drizzle rows), billing/usage records, and migration up **and** down.
- Auth/role-gating and multi-tenant isolation proven by test, including the denied-access paths (see #9853/#9948) — not assumed.
- The agent trajectory for any model-backed endpoint.
<!-- END: evidence-and-e2e-mandate -->
