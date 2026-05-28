# TEE-Native Agent Implementation Plan — Confidential AI End to End

Date: 2026-05-21
Lane: AGENT-RUNTIME (confidential agent + confidential inference)
Status: planning. The agent-side primitives exist and are unit-tested; the
production wiring, the confidential-inference unseal path, and all real
hardware quote verification are not yet built. Real TDX/CoVE quote
verification is **BLOCKED on hardware** and is called out as such throughout.

Scope discipline (repo `AGENTS.md`): this document is the plan only. It does
not refactor production code. It proposes strongly-typed additions (no `any`,
no silent fallbacks) and fail-closed gates. Nothing here invents product
behavior beyond the documented local-first + optional-Cloud topology.

---

## 0. What the device must guarantee

A TEE-native ultra-private personal AI device. The agent runtime, model
weights, KV-cache, user data, signing keys, and the local inference engine all
run inside a single-tenant whole-system confidential domain (a dstack CVM on
TDX today; a CoVE/TSM TVM on the E1 chip later). Cleartext weights, prompts,
embeddings, and KV-cache never exist outside that domain. Secrets are released
only after a fresh, nonce-bound attestation proves the measured agent + policy
+ container + NPU firmware match the release manifest, debug is disabled, and
the security version is above the rollback floor. Up to a 10% perf hit is
acceptable for this guarantee.

---

## 1. Critical assessment of the existing `tee-*` suite

### 1.1 What is real, strong, and load-bearing

The normalized evidence type and the policy verifier are the genuine core, and
they are good:

- **`tee-evidence.ts`** — `TeeEvidence` is a clean, provider-neutral normalized
  shape (`kind`, `provider`, `securityVersion`, `measurements`, `freshness`,
  `claims`, `quote`, `certificatePem`, `reportData`, `raw`). `normalizeTeeEvidence`
  is strict and fail-closed: it throws on non-objects, non-string measurements,
  non-boolean claims, non-integer `securityVersion`, and a missing `kind`. No
  `any`; the only `unknown` is at the deserialization boundary, which is correct.
  `normalizeDigest` canonicalizes the `sha256:` prefix and case. `teeMeasurementDigestMatches`
  treats an *expected* digest as required and a *missing actual* as a failure —
  the right default. **Real.**
- **`tee-policy.ts`** — `evaluateTeeEvidencePolicy` is the single trust decision
  function and it is comprehensive: kind/provider allowlists, required and
  revoked measurements, min/revoked security version, nonce match, timestamp
  freshness window (with a 60s forward-skew clamp), and required boolean claims.
  Decisions are a closed discriminated union of `reason` strings. Fail-closed:
  required-but-missing → `missing-evidence`. **Real and the centerpiece.**
- **`tee-revocation.ts`** — schema-versioned revocation manifest (measurements +
  security versions), normalizes string/number/object entries, dedupes, merges
  into a policy. Clean. **Real.**
- **`tee-release-policy.ts`** — derives a `TeeEvidencePolicy` from an OS release
  manifest (`tee.enabled/providers/measurements/requiredClaims/minSecurityVersion`).
  Maps the OS measured-boot contract into the agent's policy. **Real.**
- **`tee-runtime-config.ts`** — env-driven policy resolution
  (`ELIZA_TEE_POLICY_JSON/_PATH`, `ELIZA_TEE_RELEASE_MANIFEST_JSON/_PATH`,
  `ELIZA_TEE_REVOCATIONS_JSON/_PATH`, `ELIZA_TEE_REQUIRED`, nonce/max-age). **Real.**
- **`tee-signer-backend.ts`** — `TeeSignerBackend` decorates a `SignerBackend` and
  re-collects + re-evaluates evidence before *every* `signMessage`/`signTransaction`.
  Fail-closed by construction; the test proves the inner signer is never called on
  a failed decision. **Real.**
- **`remote-capability-endpoint-provider.ts`** — `connectRemoteCapabilityEndpointProvider`
  collects endpoint TEE evidence at provision time and `evaluateProvisionedEndpointTeeTrust`
  **throws before `syncRemoteCapabilityPlugins`** when the policy fails. The test
  proves no plugin is registered on a missing/mismatched-measurement endpoint.
  This is the strongest integration point in the suite. **Real.**
- Tests: `tee-policy.test.ts`, `tee-key-release.test.ts`, `tee-signer-backend.test.ts`,
  `tee-revocation.test.ts`, `tee-release-policy.test.ts`, `tee-runtime-config.test.ts`,
  `dstack-tee-provider.test.ts`, `remote-capability-tee-policy.test.ts` cover the
  positive and the critical negative paths. The two harness scripts
  (`tee-full-stack-local.ts`, `tee-local-smoke.ts`) exercise collect → policy →
  key-release end to end against a mock KMS and write JSON evidence artifacts.

### 1.2 What is mock, stubbed, or thin — be specific

- **No real quote verification anywhere.** `dstack-tee-provider.ts` *fetches or
  reads* a `TeeEvidence` JSON blob (`ELIZA_TEE_EVIDENCE_JSON/_URL/_PATH`,
  `DSTACK_TAPPD_URL`) and normalizes it. It never parses a TDX quote, never
  checks an Intel PCS/QvL signature, never validates RTMRs against `report_data`,
  never verifies the DICE/RA-TLS cert chain. **`evidence.quote` is carried but
  never cryptographically verified.** The policy verifier trusts whatever the
  provider hands it. This is the single biggest gap: today the system verifies a
  *self-asserted JSON document*, not a hardware attestation. This is acceptable
  for the macOS-feasible lane and unit tests, but it is **not** the security
  property the product claims, and the codebase does not currently hide that —
  it just hasn't built the verifier. (Honest gap, not slop.)
- **`HttpTeeKeyReleaseClient` does not generate or bind a fresh nonce.** The
  *policy* can carry an `expectedNonce`, but the client sends whatever nonce is
  already in the evidence; it does not (a) request a challenge nonce from the KMS,
  (b) generate an ephemeral keypair, or (c) bind `report_data = H(nonce || epk)`.
  So the HTTP path as written is replayable against a passive collector. The
  `tee-protected-agent-vm.md` and chip §3.2 docs *specify* the `report_data`
  binding, but the client does not implement it.
- **`LocalTeeKeyReleaseClient` is an HMAC KDF, not a KMS.** It derives key
  material with `HMAC-SHA256(masterSecret, keyId|context|agent|policy|device)`.
  This is a faithful *model* of "deterministic app-key bound to measurement" and
  it correctly varies output per agent/policy measurement (proven by test), but
  the `masterSecret` lives in agent memory. It is a local-dev stand-in for the
  dstack decentralized KMS, not the KMS.
- **No production wiring.** `grep` of `packages/agent/src/index.ts` shows the
  `tee-*` modules are only `export *`-ed. **Nothing in the agent boot path calls
  `resolveTeeRuntimePolicy`, installs the dstack provider, gates secret/model-key
  release, or wraps the signer with `TeeSignerBackend` at runtime.** The suite is
  a tested library with two scripts; it is not yet on the agent's actual startup
  path. `ELIZA_TEE_REQUIRED=true` resolves a policy object but no boot code
  *consumes* it to fail closed.
- **No confidential-inference path at all.** There is no model-weights unseal,
  no encrypted-at-rest weights, no `model-key` release wired into the local model
  runtime. `secretScopes: ["agent-session","model-key","remote-signing"]` exists
  only in the example deployment JSON; `model-key` has no consumer.
- **DevMode / fake-quote defenses are not centralized.** The policy *can* require
  `debugDisabled:true`, but there is no single "production profile" that a caller
  can't forget to apply, and no rejection of dstack DevMode evidence beyond a
  caller remembering to set the claim. No KMS-identity pinning, no RA-TLS cert
  verification toggle, no refusal of HTTP (non-TLS) KMS in production.
- **Two `Tee*` type homes.** `packages/core/src/types/tee.ts` defines a *legacy*
  `TeeAgent`/`RemoteAttestationQuote`/`TEEMode`/`TeeType` set (old plugin-tee
  shape). The *new* canonical types live in `packages/agent/src/services/tee-evidence.ts`.
  These do not conflict (different concepts) but the naming overlap is a trap.
  Plan: leave core's legacy types alone unless a consumer needs them; treat
  `tee-evidence.ts` as the single source of truth for confidential-AI evidence
  and document that in core's file.

### 1.3 Contracts that already exist (and we must not redefine)

- The normalized `TeeEvidence` shape and `evaluateTeeEvidencePolicy` decision
  union are the cross-layer contract. The chip lane (`06-os-on-tee-software.md`)
  and OS lane (`tee-measured-boot-contract.md`) both explicitly anchor to them
  and promise *not* to fork them. Keep it that way.
- Measurement names: `boot`, `os`, `agent`, `policy`, `device`, `container`,
  `compose`, `npuFirmware`, `gpuFirmware` (+ open string). Claims: `debugDisabled`,
  `productionLifecycle`, `secureBoot`, `memoryEncrypted`, `ioProtected`,
  `gpuProtected`, `npuProtected`.

**Verdict:** the policy/evidence/revocation core is production-grade and the
right design. The verifier of *real* quotes, the *nonce/epk binding*, the
*confidential-inference unseal path*, the *production hardening profile*, and
the *boot wiring* are the missing pieces. The work is integration + a real
verifier, not a rebuild.

---

## 2. Confidential AI inference path (the headline)

### 2.1 Goal

Model weights are encrypted at rest on the device's storage. They are decrypted
only inside the confidential domain, only after attestation-gated release of the
`model-key`, and loaded directly into the in-domain local model runtime (eliza-1)
and the NPU. Prompts, embeddings, KV-cache, and generated tokens live only in
private (memory-encrypted) pages and never cross to a non-measured device in
cleartext.

### 2.2 Weights-at-rest + unseal flow (local-in-TEE)

```text
1. Boot the confidential domain (dstack CVM / CoVE TVM).
   OS/silicon lane produces the measured-launch quote.
2. In-domain attestation agent assembles TeeEvidence (kind, measurements
   incl. agent+policy+container+npuFirmware, claims, freshness).
3. Agent boot resolves the production TeeEvidencePolicy
   (resolveTeeRuntimePolicy + production profile, §4.2).
4. Agent requests model-key from KMS:
     - generate ephemeral X25519 keypair (epk) in-domain
     - obtain a fresh verifier nonce
     - bind reportData = SHA256(nonce || epk_pub) into the quote
     - send {keyId:"model-key", evidence, policy} over RA-TLS
5. KMS verifies the quote (RTMRs/measurements, signature, freshness, policy),
   derives the app-deterministic model-key, wraps it to epk, returns it.
6. Agent unwraps model-key in-domain, decrypts the weights blob
   (AES-256-GCM / XChaCha20-Poly1305) into private memory.
7. Weights stream into the local model runtime (eliza-1) and the NPU
   private queues. The model-key and cleartext weights never leave the domain.
8. Inference: prompts/embeddings/KV-cache stay in private pages. Output crosses
   to the UI only through the explicit shared-page copy path.
```

If step 5 fails (tampered agent/OS/policy → measurement-mismatch, stale quote,
debug enabled, rolled-back version), the KMS withholds `model-key`, the weights
stay ciphertext, and **inference is impossible** — the negative path is enforced
by *data unavailability*, not by a software check that could be patched out.
This is the property called out in chip §3.4 and it is the design we adopt.

### 2.3 KV-cache, prompts, user data confinement

- `MILADY_STATE_DIR`/`ELIZA_STATE_DIR` (default `~/.local/state/milady`) maps to a private,
  sealed-key-encrypted volume that only mounts after attestation-gated key
  release. (dstack does this via LUKS2 — see the LUKS2 advisory in §5; we must
  bind the volume key to attestation, not to a host-readable key.)
- KV-cache and intermediate tensors live only in confidential (memory-encrypted)
  pages. There is no swap to a non-measured device; if swap is required it must
  be encrypted with an in-domain key.
- Cleartext crosses the boundary only through the shared-page virtio path and
  only for data the user marked exportable (a measured policy field). UI text,
  rendering, and notifications are explicitly allowed outside.

### 2.4 Maps to the NPU-as-confidential-I/O and eliza-1

- The chip lane's NPU private queues (lane 03, `npuProtected` claim,
  `npuFirmware` measurement) are the hardware mechanism that keeps weights and
  activations off shared buses during inference. The agent's contract with that
  layer is: do not release `model-key` and do not start private inference unless
  `claims.npuProtected === true` and `measurements.npuFirmware` matches the
  manifest. This is a policy assertion the agent already supports; the plan adds
  it to the production profile (§4.2).
- eliza-1 is the in-domain local model runtime. The plan's only requirement on
  it: it must accept weights from an in-memory decrypted buffer (no temp file
  on a non-measured FS) and must not log prompts/weights anywhere reachable by
  the host (§4.4).

### 2.5 Local-in-TEE vs cloud-routed inference

| Aspect | Local-in-TEE (default) | Cloud-routed (opt-in) |
| --- | --- | --- |
| Where weights decrypt | In-device CVM/TVM | dstack CVM on TDX + H100 confidential GPU |
| Verifier/KMS | On-device verifier (`eliza-local-verifier`) | Cloud KMS (added to `allowedProviders`) |
| What the agent sends | nothing leaves the device | only user-marked-exportable prompt data |
| Extra claim required | `npuProtected` + `npuFirmware` | `gpuProtected` + `gpuFirmware` |
| Policy difference | `required:true`, local golden digests | adds Cloud KMS provider + GPU claim/measurement |

The agent must run the **same** `evaluateTeeEvidencePolicy` for both; only the
policy object differs (allowed providers, GPU vs NPU claim/measurement). When
cloud-routed, the agent must attest the *remote* endpoint's evidence
(`connectRemoteCapabilityEndpointProvider`, already fail-closed) before sending
any prompt, and must include the H100 GPU confidential-compute claim
(`gpuProtected`) + `gpuFirmware` measurement in the remote policy.

---

## 3. End-to-end attestation + key release contract

### 3.1 The flow, by component

```text
device evidence (OS/silicon)                      [OS + chip lanes]
  -> in-domain attestation agent emits TeeEvidence  [dstack-tee-provider / chip agent]
  -> normalizeTeeEvidence(...)                       [tee-evidence.ts]  STRICT
  -> evaluateTeeEvidencePolicy(evidence, policy)     [tee-policy.ts]    TRUST DECISION
       policy from resolveTeeRuntimePolicy(env)      [tee-runtime-config.ts]
       + mergeTeeRevocationsIntoPolicy(...)          [tee-revocation.ts]
       + production profile (§4.2)                   [NEW]
  -> trusted? release secret                         [tee-key-release.ts]
       model-key | agent-session | remote-signing
  -> unseal: decrypt weights / mount state / sign    [NEW consumers]
```

### 3.2 Freshness / nonce / report_data binding (must be added)

This is the contract the docs specify but the client does not yet implement:

1. The agent generates an ephemeral X25519 keypair `epk` per release request.
2. The agent obtains a fresh challenge `nonce` from the verifier/KMS (or, in
   local mode, from the local verifier).
3. The quote request sets `report_data = SHA256(nonce || epk_pub)` so the quote
   is bound to *this* live channel and is not replayable.
4. `policy.expectedNonce` is set to the issued nonce; `policy.maxAgeMs` bounds
   staleness; `evaluateTeeEvidencePolicy` rejects `missing-nonce`/`nonce-mismatch`/
   `timestamp-stale`.
5. The KMS wraps the released key to `epk_pub`; the agent unwraps in-domain.

`HttpTeeKeyReleaseClient` must be extended (or a `RaTlsTeeKeyReleaseClient`
added) to do steps 1–3 and to *verify* the returned key was wrapped to its epk.
**Never accept a key for a quote whose `report_data` the client did not bind to
a nonce it generated.**

### 3.3 Measurement matching set (the agent's required claims)

For a production local-in-TEE confidential-AI release the policy must require:

- `requiredMeasurements`: `agent`, `policy`, `container`/`compose`, `os`, `boot`,
  `device`, and `npuFirmware` (when local private inference is enabled), each
  matching the signed reproducible-build manifest's golden digest.
- `requiredClaims`: `debugDisabled:true`, `secureBoot:true`, `memoryEncrypted:true`,
  `ioProtected:true`, `productionLifecycle:true`, and `npuProtected:true` (local)
  or `gpuProtected:true` (cloud-routed).
- `minSecurityVersion`: the anti-rollback floor from the RoT counter.
- `expectedNonce` + `maxAgeMs`: per §3.2.
- revocations merged from the signed revocation manifest.

### 3.4 Rollback / revocation

- Rollback: `minSecurityVersion` + `revokedSecurityVersions` (both supported).
- Revocation: `revokedMeasurements` per name. The revocation manifest is signed
  by an authority (`authority` field) — **the agent must verify that signature
  before merging** (gap: `mergeTeeRevocationsIntoPolicy` trusts the manifest;
  add signature verification at the load boundary in `tee-runtime-config.ts`).

### 3.5 Map to dstack KMS deterministic app keys

dstack's KMS runs in its own TEE, verifies the TDX quote, and derives a
*deterministic per-app key bound to the measured app identity* (compose digest +
args + env) with authorization enforced by on-chain policy that operators cannot
bypass. The agent's `model-key`/`agent-session`/`remote-signing` scopes map to
dstack `keyId`s; the binding inputs (agent/policy/container measurements) in our
`deriveKeyMaterial` model mirror dstack's app-identity binding. In production the
`LocalTeeKeyReleaseClient` HMAC model is replaced by the real dstack guest-agent
socket (`/var/run/dstack.sock`) → KMS path; our `HttpTeeKeyReleaseClient` becomes
an RA-TLS client to that socket/endpoint.

---

## 4. Secret & capability gating

### 4.1 `ELIZA_TEE_REQUIRED=true` behavior (must be wired)

Today `resolveTeeRuntimePolicy` returns `{ required:true, ... }` but no boot code
consumes it. Plan: at agent boot, if `ELIZA_TEE_REQUIRED==="true"` (or a policy
resolves with `required:true`), the agent must:

- collect evidence via the configured provider and evaluate it once at boot;
- if not trusted, **refuse to release any high-value secret** (model-key,
  signing key, remote-signing) and refuse to sync remote capability plugins —
  the agent may still boot in a degraded, secret-less mode but must surface the
  failed decision (structured logger, `[TeeBootGate]`), never silently continue
  with secrets.
- wrap the active `SignerBackend` in `TeeSignerBackend` so *every* sign re-checks.
- gate `model-key` release behind the same policy (so weights stay sealed).

### 4.2 A single production profile (new, prevents footguns)

Add a `teeProductionProfile()` helper that returns the non-negotiable claim/
freshness floor and is intersected with the resolved policy, so a caller cannot
forget `debugDisabled`/`memoryEncrypted`/freshness in production:

```ts
// strongly typed, no fallbacks; rejects dev/debug evidence by construction
export function teeProductionProfile(): Required<Pick<TeeEvidencePolicy,
  "required" | "requiredClaims">> & Pick<TeeEvidencePolicy, "maxAgeMs"> {
  return {
    required: true,
    requiredClaims: {
      debugDisabled: true,
      secureBoot: true,
      memoryEncrypted: true,
      ioProtected: true,
      productionLifecycle: true,
    },
    maxAgeMs: 300_000,
  };
}
```

The boot path must merge this into the resolved policy whenever the build is a
production/`stable` channel, never accepting DevMode/debug evidence under it.

### 4.3 Host↔guest capability bridge + RemoteSigningService

Per `tee-protected-agent-vm.md`: the host owns UI/network/storage-brokering; the
guest owns secrets, signing keys, decrypted model keys, private tool output.
Allowed host→guest calls: `plugin.modules.list`, approved remote plugin
actions, workspace-scoped file IO, terminal exec only when policy allows the
endpoint, and signing through `RemoteSigningService`. Denied by default: host FS
escape, raw device access, unmeasured plugin loading, unsigned policy mutation,
and **secret export to host logs/env dumps/crash reports/analytics**.
`RemoteSigningService` must use `TeeSignerBackend` so the host can request a
signature but the key never leaves the domain and every sign re-attests.

### 4.4 Deny secret export to host surfaces (new gate)

- No secret/weight/prompt value may be written to a logger that ships off-domain,
  to `process.env` dumps, to crash/telemetry payloads, or to a non-measured FS.
- Add a redaction assertion at the structured-logger boundary and a CI gate that
  greps the crash/telemetry serializers for secret-scope keys. (Logger-only per
  commandment 9; never `console`.)

### 4.5 Fail-closed on missing/stale/debug/mismatched evidence

The decision union already encodes every failure cause. The plan is to ensure
**every** high-value path routes through `evaluateTeeEvidencePolicy` and throws
on `!trusted`: plugin sync (done — `remote-capability-endpoint-provider`),
signing (done — `TeeSignerBackend`), model-key release (to wire), agent-session
secret release (to wire), and remote capability calls (done). No path may have a
fallback that proceeds without a `trusted:true` decision.

---

## 5. dstack provider hardening (defenses against the known issues)

The brief and dstack's own advisories establish the threat classes. Concrete
agent-side defenses:

1. **KMS attestation bypass** — never trust a key the agent did not bind to its
   own fresh nonce + epk (§3.2). The agent independently runs
   `evaluateTeeEvidencePolicy` on the evidence *before* using any returned key;
   it does not delegate the trust decision to the KMS response alone. Verify the
   returned key is wrapped to the agent's epk.
2. **Permissive DevMode auth / fake-quote pathways** — the production profile
   (§4.2) requires `debugDisabled:true` and `productionLifecycle:true`; DevMode
   or simulated quotes (e.g. `quote:"simulated-cove-quote"`, `hardwareVendor:"mock-*"`)
   must be rejected. Add an explicit allowlist of accepted `verifier`/`hardwareVendor`
   values in production, and refuse `kind` values that indicate mock providers.
   The *real quote signature* must be verified (BLOCKED on hardware; see §7) —
   until then production must not claim hardware trust.
3. **Disabled-TLS-verification gateway** — the KMS client must use RA-TLS with
   full certificate-chain verification pinned to the expected KMS identity;
   **refuse plain HTTP and refuse `NODE_TLS_REJECT_UNAUTHORIZED=0`**. Add a guard
   that throws if the KMS URL is not `https:`/RA-TLS in production
   (`normalizeBaseUrl` already enforces http(s); tighten to https-only +
   identity pin).
4. **KMS identity pinning** — pin the KMS's measured identity (its own quote /
   on-chain policy identity) so a rogue or downgraded KMS cannot answer. Add
   `expectedKmsMeasurement` / `expectedKmsPublicKey` to the release client config
   and verify it on the RA-TLS handshake.
5. **World-readable key material / decrypted env vars** — never place secrets or
   the decrypted weights/model-key in env vars or world-readable files. Keep them
   in-process memory; the sealed state volume key must be attestation-bound, not
   a static host-readable key (the LUKS2 advisory GHSA-jxq2-hpw3-m5wf is exactly
   this risk). Zeroize key buffers after use.
6. **Decompression bomb / malformed evidence** — `normalizeTeeEvidence` already
   rejects malformed shapes; add a max-size cap on the evidence/quote payload in
   `dstack-tee-provider.ts` HTTP/file reads and a JSON-parse size guard before
   parsing.
7. **Cert / constant-time issues** — use constant-time comparison for nonce and
   wrapped-key checks; rely on a vetted RA-TLS library for cert verification
   rather than hand-rolled parsing.

These are agent-side compensating controls; they do not fix dstack itself but
ensure the agent never extends trust to a quote/KMS it cannot independently
verify and pin.

---

## 6. The agent↔OS↔silicon contract

### 6.1 Fields the agent consumes (provider-neutral)

The agent consumes only the normalized `TeeEvidence` from `tee-evidence.ts`,
regardless of provider (`dstack`/`tdx`/`cove`/`eliza-vault`). Required from the
layer below:

- `kind`, `provider`, `securityVersion`, `freshness{nonce,timestamp,verifier}`,
  `quote`, `certificatePem`, `reportData`.
- `measurements`: `boot`, `os`, `agent`, `policy`, `device`, `container`/`compose`
  (containerized), `npuFirmware` (local private inference), `gpuFirmware`
  (cloud confidential GPU).
- `claims`: `debugDisabled`, `secureBoot`, `memoryEncrypted`, `ioProtected`,
  `productionLifecycle`, `npuProtected` (local), `gpuProtected` (cloud).

### 6.2 Is the existing `requiredClaims` set the right contract?

Yes. `debugDisabled`, `secureBoot`, `memoryEncrypted`, `ioProtected` are the
correct core set, and the type already carries `productionLifecycle`,
`npuProtected`, `gpuProtected`. For confidential AI the only additions needed
are *usage of* the already-present fields:

- **Use `npuProtected` + `measurements.npuFirmware`** as a hard gate for local
  private inference (present in types and fixtures; not yet required by any
  production profile).
- **Use `gpuProtected` + `measurements.gpuFirmware`** for cloud-routed inference
  on the H100 confidential GPU (present in types; no consumer yet).
- Consider a `monitor` measurement name (TSM/security-manager digest) for the
  CoVE path — chip §2.1/§3.1 emits `monitor`; `TeeMeasurementName` is an open
  string so it already type-checks, but add `"monitor"` to the named union for
  discoverability.
- Optionally add a `modelWeights` measurement name so the released-against
  weights digest can be matched (defense in depth: bind `model-key` release to
  the expected weights digest). Open-string already allows it; naming it makes
  it a first-class contract field.

No breaking changes to the type are required — the contract is right; the work
is *enforcing the optional fields* in the production profile.

---

## 7. Sequenced roadmap

Effort in person-weeks (PW). Every blocked item names its dependency and stays
fail-closed.

### Phase A — buildable now (no hardware), software-only

| ID | Work item | Effort | Gate |
| --- | --- | --- | --- |
| A1 | Extend `tee-full-stack-local.ts` with real policy vectors: per-topology policies (local-only, desktop, cloud-routed) + golden/tampered fixtures for every decision reason (kind/provider/measurement/version/nonce/timestamp/claim/revoked). | 1 | `tee-full-stack-local` |
| A2 | Negative-test matrix: a vitest fixture asserting each `reason` in the decision union for crafted evidence. Pure data, no `any`. | 1 | new `tee-evidence-policy.matrix.test.ts` |
| A3 | `teeProductionProfile()` + profile-merge helper (§4.2); unit tests that prove DevMode/debug evidence is rejected under it. | 1 | unit |
| A4 | Boot wiring (§4.1): consume `resolveTeeRuntimePolicy` at agent startup, fail-closed `[TeeBootGate]`, wrap signer in `TeeSignerBackend`, gate model-key + agent-session release. | 2 | integration test + smoke |
| A5 | Revocation-manifest signature verification at load (§3.4); deny unsigned/invalid manifests. | 1 | unit |
| A6 | dstack provider hardening that needs no hardware: payload size cap (§5.6), https-only + KMS-identity-pin config fields (§5.3/5.4), constant-time nonce/key compare (§5.7), reject mock `verifier`/`hardwareVendor`/simulated quotes under production profile (§5.2). | 2 | unit |
| A7 | Nonce + epk binding in the key-release client (§3.2): generate epk, request/echo nonce, set `report_data`, verify key wrapped to epk. (Crypto only; no real quote yet.) | 2 | unit |
| A8 | Confidential-inference unseal *plumbing* (§2.2 steps 4–7) against the mock KMS: encrypt a weights blob at rest, release `model-key`, decrypt in-memory, hand to the local runtime; assert no temp-file/plaintext on disk and no secret in logs (§4.4). | 3 | new `tee-confidential-inference-local` script |
| A9 | CI gate (§4.4): grep crash/telemetry serializers + env-dump paths for secret-scope keys; fail on leak. | 0.5 | new lint gate |

Critical path for Phase A: A3 → A4 → A8 (the headline unseal plumbing depends on
the production profile and boot wiring). A1/A2/A5/A6/A7/A9 parallelize.

### Phase B — cloud-TDX-gated (real dstack KMS on TDX + H100)

| ID | Work item | Effort | Gate |
| --- | --- | --- | --- |
| B1 | Real dstack guest-agent integration: read evidence from `/var/run/dstack.sock` / `DSTACK_TAPPD_URL`, request real TDX quote, populate `TeeEvidence`. | 3 | dstack CVM on TDX |
| B2 | Real TDX quote verification (Intel PCS/QvL): verify quote signature, RTMRs, and `report_data == H(nonce\|\|epk)`. **The current provider does none of this.** | 4 | TDX hardware |
| B3 | Real RA-TLS KMS client with KMS-identity pinning; deterministic app-key release for `model-key`/`agent-session`/`remote-signing`. | 3 | dstack KMS |
| B4 | H100 confidential-GPU attestation for cloud-routed inference: require `gpuProtected` + `gpuFirmware`; attest the remote endpoint before sending any prompt. | 3 | TDX + H100 |

Phase B is **BLOCKED on TDX/H100 hardware availability**. Until B2 lands, the
system must not claim hardware-verified trust; it verifies a signed evidence
document only. State this in any release notes.

### Phase C — chip-silicon-gated (real CoVE quote on E1)

| ID | Work item | Effort | Gate |
| --- | --- | --- | --- |
| C1 | Consume real CoVE quote from the E1 in-domain attestation agent (chip §3.1); verify DICE/RoT cert chain + RTMR/`report_data` binding. | 4 | E1 silicon / CoVE QEMU+Salus |
| C2 | NPU private-queue gate: enforce `npuProtected` + `npuFirmware` before private inference (binds chip lane 03). | 2 | E1 secure I/O |
| C3 | Attestation-bound sealed state volume (replace host-readable LUKS2 key with attestation-released key). | 2 | E1 + KMS |

Phase C is **BLOCKED on E1 silicon / a riscv64 CoVE QEMU+Salus target** (chip
lane WI-6/WI-7/WI-9). It stays fail-closed with the named dependency.

### Fail-closed gate summary

- Phase A gates close immediately (software, mock KMS, real crypto).
- Phase B gates stay BLOCKED on TDX/H100; the agent must refuse to assert
  hardware trust until B2 verifies real quotes.
- Phase C gates stay BLOCKED on E1 silicon; same rule.
- At every phase, `ELIZA_TEE_REQUIRED=true` + production profile means: no
  trusted evidence → no model-key, no signing, no remote-plugin sync, no private
  inference. Degraded boot is allowed; silent secret release is never allowed.

---

## 8. Open decisions for a human

- **Weights encryption envelope** — AES-256-GCM vs XChaCha20-Poly1305, and
  whether weights are a single blob or per-shard (per-shard lets large models
  stream-decrypt without a full plaintext copy in memory). Recommend per-shard.
- **`modelWeights` measurement** — bind `model-key` release to the expected
  weights digest as defense in depth? Recommend yes (defense in depth, cheap).
- **Local verifier trust root** — for local-only mode the on-device verifier is
  rooted in the RoT-derived key; confirm the local verifier's measured identity
  is itself in `measurements.policy`/`device` so it can't be swapped.
- **Cloud KMS as escrow** — whether cross-device key escrow via Eliza Cloud is in
  scope for v1 (the chip doc lists it as optional). Out of scope unless requested.
