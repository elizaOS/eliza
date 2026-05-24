> **Mirror.** Authoritative copy lives in the outer milady monorepo at `milady/docs/security/KEY-LIFECYCLE.md`. Relative links below (`../../POLICIES/...`) resolve in the outer monorepo, not inside this submodule.

# Key Lifecycle

Authoritative lifecycle documentation for every key class used in the Eliza stack. Implements [`../../POLICIES/12-cryptography.md`](../../POLICIES/12-cryptography.md) against the contract in [`audits/KMS-CONTRACT.md`](audits/KMS-CONTRACT.md) and the Steward spec in [`audits/STEWARD-KMS-SPEC.md`](audits/STEWARD-KMS-SPEC.md).

## Namespace layout

```
kek                       — master key-encryption key, lives in Steward / HSM
dek.<service>.<purpose>   — wrapped data-encryption keys per namespace
                            examples:
                              dek.cloud.pii
                              dek.cloud.connector_tokens
                              dek.cloud.billing
                              dek.training.dataset.<id>
auth.jwt                  — Cloud session JWT signing key (Ed25519)
webhook.hmac              — inbound webhook HMAC secret per integration
plugin.signing            — first-party plugin manifest signing (Ed25519)
release.sigstore          — release signing via Sigstore (short-lived OIDC-bound)
prompt.hmac               — DSPy prompt artifact HMAC
```

## Per-class lifecycle

### `kek` (master KEK)

| Stage | Detail |
|---|---|
| Creation | Generated inside Steward / HSM at deploy time. Never exists outside the KMS process in plaintext. Bootstrap via shamir-split or cloud-provider HSM. |
| Use | Wraps / unwraps DEKs only. Never used to encrypt application data directly. |
| Rotation | 730 days. Triggers re-wrap of every DEK. |
| Dual-accept | 30 days during which both old + new KEK can unwrap. After window, old KEK destroyed. |
| Revocation | Emergency: see [`INCIDENT-RUNBOOK.md`](INCIDENT-RUNBOOK.md) Playbook A. |
| Audit | Every wrap / unwrap operation logged with operator + AAD. |

### `dek.<namespace>` (data-encryption keys)

| Stage | Detail |
|---|---|
| Creation | Per namespace at first encryption call; persisted wrapped under KEK. |
| Use | AES-256-GCM with namespace+row AAD. Loaded into process memory at use time only. |
| Rotation | 365 days. Re-wrap with current KEK; re-encrypt eagerly for high-value namespaces (PII, connector tokens), lazily for bulk. |
| Dual-accept | 30 days. |
| Revocation | DSR / retention destruction destroys the DEK; ciphertext becomes unrecoverable. |
| Audit | Issuance, rotation, destruction, anomalous access patterns. |

### `auth.jwt`

| Stage | Detail |
|---|---|
| Creation | Generated inside Steward; public-key exported to API for verification. |
| Use | Sign Cloud session JWTs (short-lived, ≤ 1h). |
| Rotation | 90 days; new JWTs use new key; old key remains for the dual-accept window. |
| Dual-accept | 7 days. |
| Revocation | Emergency roll on incident (Playbook D); invalidates all live sessions. |
| Audit | Issuance and revocation events. Every JWT verify logged as part of normal auth. |

### `webhook.hmac`

| Stage | Detail |
|---|---|
| Creation | Per inbound webhook integration on first configuration. |
| Use | HMAC-SHA256 verification of incoming requests. |
| Rotation | 180 days; both secrets accepted during window. |
| Dual-accept | 14 days. |
| Revocation | On integration removal; immediate. |
| Audit | Issuance and revocation; verify-failures alerted. |

### `plugin.signing`

| Stage | Detail |
|---|---|
| Creation | First-party publisher Ed25519 key generated in Steward; public key embedded in clients. |
| Use | Sign plugin manifests. |
| Rotation | 365 days; clients accept the previous key during dual-accept. |
| Dual-accept | 30 days. |
| Revocation | Publish to revocation list; clients refuse manifests signed only by revoked key. |
| Audit | Sign events; verify-failures (in runtime) reported as telemetry. |

### `release.sigstore`

| Stage | Detail |
|---|---|
| Creation | Sigstore Fulcio issues an ephemeral cert per release, bound to the build's OIDC identity. |
| Use | Sign release artifacts and container images. Public verification via Rekor transparency log. |
| Rotation | Each release. |
| Revocation | Not applicable — verification is identity-bound + transparency-logged. |
| Audit | Rekor transparency log entries. |

### `prompt.hmac`

| Stage | Detail |
|---|---|
| Creation | Generated inside Steward; loaded into runtime processes via secure boot. |
| Use | HMAC-SHA256 over DSPy-optimized prompt artifacts. Verified at load by `OptimizedPromptService`. |
| Rotation | 365 days; re-HMAC the artifact corpus on rotation. |
| Dual-accept | 30 days. |
| Revocation | On suspected leak; immediate roll + re-HMAC. |
| Audit | Sign + verify outcomes. |

## Cross-cutting

- **No keys in source.** CI gates enforce ([`16`](../../POLICIES/16-secure-development.md)).
- **No keys in logs.** OTel collector redaction enforces ([`14`](../../POLICIES/14-logging-monitoring.md)).
- **Quarterly key inventory** by Security Lead.
- **Destroy events are non-reversible** and logged as `audit_events` rows with reason.
