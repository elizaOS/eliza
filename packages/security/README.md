# @elizaos/security

Foundation package for elizaOS SOC2 compliance. Provides three things:

1. A single `KmsClient` interface that every encryption/signing/HMAC call in elizaOS must flow through.
2. An `AuditDispatcher` + `AuditEvent` schema that every privileged action must emit through.
3. Low-level AEAD/HKDF primitives used internally by the adapters.

Open-source only. Production backs onto [Steward](https://github.com/Steward-Fi/steward) — elizaOS's agent-wallet / credential-proxy / auth platform. No AWS KMS, no GCP KMS, no proprietary services.

## KMS

```ts
import { createKmsClient, orgKey } from "@elizaos/security";

const kms = createKmsClient({
  steward: {
    baseUrl: process.env.STEWARD_URL!,
    tokenProvider: () => issueShortLivedToken(),
  },
});

const key = orgKey(org.id, "dek");
const { ciphertext, nonce, authTag, keyId, keyVersion } = await kms.encrypt(
  key,
  new TextEncoder().encode(plaintext),
  new TextEncoder().encode(`table=users|row=${row.id}|col=ssn`), // AAD
);
```

### Adapters

- **`memory`** — in-process. Used by tests.
- **`local`** — single-user desktop. HKDF-derives all sub-keys from a 32-byte root resolved via `@elizaos/vault`'s OS-keychain / scrypt-passphrase machinery.
- **`steward`** — production. HTTP client against Steward's credential-proxy / KMS endpoints (see "Steward endpoint contract" below). It performs bearer-authenticated JSON requests and validates typed base64 responses.

Backend selection:

```
ELIZA_KMS_BACKEND  memory | local | steward
ELIZA_LOCAL_MODE   when "1", defaults to local
NODE_ENV=test      defaults to memory
otherwise          defaults to steward
```

### Key namespace

Mandatory convention enforced by `parseKeyId` / `isValidKeyId`:

```
system:<purpose>/v<n>          system keys (rotated by ops)
org:<org_id>/dek/v<n>          org data-encryption keys
org:<org_id>/hmac/v<n>         org integrity keys
user:<user_id>/connector/v<n>  user-scoped connector token wrap keys
```

### Operating rules

1. No `crypto.createCipheriv` outside `@elizaos/security`. All encryption-at-rest goes through `KmsClient`.
2. AAD is mandatory for any record where the key bundle is not unique per record. Always include `table`, `row_id`, `column`.
3. Rotation does not break decrypt. Old `keyVersion` records are decryptable until a background re-encrypt job runs.
4. `KmsClient` instances are dependency-injected. No module-level singletons that capture process env.

## Audit

```ts
import { AuditDispatcher, ConsoleSink, FileSink } from "@elizaos/security";

const audit = new AuditDispatcher({
  sinks: [new ConsoleSink(), new FileSink("/var/log/eliza/audit.jsonl")],
});

await audit.emit({
  actor: { type: "user", id: user.id },
  action: "auth.login",
  result: "success",
  ip: req.ip,
  user_agent: req.headers["user-agent"],
  request_id: req.id,
  metadata: { email_hash: hash(user.email), method: "password" },
});
```

Every event is validated against `AuditEventSchema` (Zod), passed through a per-action-prefix metadata allowlist (PII redaction), and fanned out to every sink. One sink failing does not prevent the others from receiving the event.

The set of legal action names is `AUDIT_ACTIONS` in `src/audit/actions.ts`. Adding a new action requires a code change here plus a matching entry in `METADATA_ALLOWLIST` in `src/audit/dispatcher.ts`.

## Steward endpoint contract

The production adapter calls the following Steward endpoints:

```
POST   /v1/kms/keys                              { keyId, rotationDays? } -> { keyId, version }
POST   /v1/kms/keys/:keyId/rotate                -> { keyId, newVersion }
GET    /v1/kms/keys/:keyId/versions              -> { versions: number[] }
POST   /v1/kms/keys/:keyId/encrypt               { plaintext_b64, aad_b64? } -> { ciphertext_b64, nonce_b64, auth_tag_b64, version }
POST   /v1/kms/keys/:keyId/decrypt               { ciphertext_b64, nonce_b64, auth_tag_b64, aad_b64?, version? } -> { plaintext_b64 }
POST   /v1/kms/keys/:keyId/hmac                  { data_b64 } -> { tag_b64 }
POST   /v1/kms/keys/:keyId/hmac/verify           { data_b64, tag_b64 } -> { valid: boolean }
POST   /v1/kms/keys/:keyId/sign                  { data_b64, algorithm } -> { signature_b64, algorithm, version }
POST   /v1/kms/keys/:keyId/verify                { data_b64, signature_b64, algorithm } -> { valid: boolean }
GET    /v1/kms/keys/:keyId/public                { algorithm? } -> { public_key_b64, algorithm }
```

Auth: short-lived OIDC bearer (preferred) or mTLS. Reuses the credential-proxy auth pattern from `packages/cloud-api/src/steward/embedded.ts`.

`HttpSink` can POST validated audit events to a Steward-fronted append-only audit endpoint once that endpoint is provisioned.

## Adoption checklist for other packages

1. Take a `KmsClient` via constructor injection — never construct one yourself.
2. Take an `AuditDispatcher` the same way.
3. Replace any direct `node:crypto` cipher/hmac/sign call with the corresponding `KmsClient` method.
4. Every privileged code path emits exactly one `AuditEvent` with `actor`, `action`, `result`, and (where applicable) `resource`.
5. Never put raw PII in `metadata` — the dispatcher will drop it, but it's better not to pass it in.

## SOC2 controls

The control surface this package serves is mapped in [`docs/SOC2.md`](docs/SOC2.md):

- **C1.1** (encryption at rest) — AES-256-GCM envelope encryption with mandatory AAD for all Confidential / Restricted data.
- **CC6.7** (encryption in transit) — HMAC-SHA256 and Ed25519 signing primitives used by webhook ingress and plugin manifest verification.
- **CC6.8** (integrity) — DSPy prompt HMAC verification and plugin manifest verification ride this package's primitives.

Audit-on-use is enforced by the `AuditDispatcher`: every privileged action emits an `AuditEvent` through it.
