> **Mirror.** Authoritative copy lives in the outer milady monorepo at `milady/docs/security/THREAT-MODEL.md`. Relative links below (`../../POLICIES/...`) resolve in the outer monorepo, not inside this submodule.

# Eliza Stack — Threat Model

This is the Eliza-specific threat model. Standard SaaS threats (DDOS, SQLi, etc.) are covered by the underlying frameworks and platform; this document focuses on what makes Eliza different.

## Trust boundaries

```
[User device]                            [Eliza Cloud]
  - Local agent runtime          ←→        - Auth / billing / app registry
  - Plugins (sandboxed)          ←→        - Container deploy
  - Connectors (OAuth tokens)              - Observability sink (OTel ingress)
  - DSPy prompt artifacts                  - KMS / Steward
  - Local model artifacts                  - Subprocessors (LLM APIs, payment, etc.)
```

The boundary that matters: anything that ships from device → Cloud is in audit scope. Local-only operation is the customer's responsibility (we provide signed releases and a verifiable build, but we cannot observe their machine).

## Threats

### T1. Plugin compromise (supply chain)

**Vector.** An attacker publishes a malicious plugin to the registry, or compromises an existing legitimate plugin's publisher account.

**Impact.** Plugin runs inside the user's runtime; can attempt to access connector tokens, exfiltrate memory/conversation content, or pivot to the Cloud session.

**Mitigations.**
- Signed manifest required for First-party / Partner tiers ([24](../../POLICIES/24-plugin-connector-trust.md)).
- Sandboxed worker process with declared-permission enforcement.
- Published revocation list checked at install + periodically.
- SBOM + Cosign signature on first-party plugin builds.

**Residual.** Community-tier plugins have no human review. Customer install dialog labels these clearly.

### T2. Sub-agent escape (PTY-spawned coding agents)

**Vector.** A coding sub-agent (`coding-agent` skill — Claude / Codex / OpenCode / Pi via PTY-backed bash) is jailbroken via prompt-injection in tool output, performs out-of-scope filesystem or network actions.

**Impact.** Workspace tampering; potential exfiltration of source / secrets present in the workspace.

**Mitigations.**
- Spawn is scoped to a workspace directory; sealed-env limits secret exposure.
- Every spawn emits a telemetry event captured by the OTel pipeline.
- Bridge HTTP endpoints (read-only loopback) restrict parent-state access.
- AGENTS.md / CLAUDE.md operational constraints (no stash, no branch-switch).

**Residual.** A determined jailbreak with shell access can do real damage inside the workspace. Customer-side; document expectations.

### T3. Model poisoning / training data leakage

**Vector.** Adversarial or contaminated data enters a training corpus; or a customer's confidential data leaks into a publicly released model.

**Impact.** Released model emits unsafe or confidential output; brand and legal exposure.

**Mitigations.**
- Default-no on customer data for training ([23](../../POLICIES/23-ai-ml-model-governance.md)).
- `model_lineage.json` manifest per release with consent-class breakdown.
- Red-team eval (incl. training-data extraction probes) before release.
- Cosign signing on artifacts; HMAC on DSPy prompt assets.

**Residual.** Subtle data leakage from class-C opt-in customer data — mitigated by training-data deduplication and minimization.

### T4. KMS / Steward compromise

**Vector.** Attacker obtains master KEK, the Steward signing key, or the database holding wrapped DEKs.

**Impact.** Catastrophic — decryption of all Confidential / Restricted data in Cloud.

**Mitigations.**
- KEK never leaves Steward in plaintext; HSM-backed where available.
- Strict AAD on every envelope; ciphertext alone (no AAD) cannot be decrypted in another context.
- KMS operations audited with append-only retention.
- Dual-accept windows allow detection during rotation.

**Residual.** KEK loss = data loss for keys not yet rotated. Documented as SEV-0 in [`INCIDENT-RUNBOOK.md`](INCIDENT-RUNBOOK.md).

### T5. Supply-chain attack (npm / HuggingFace / container base)

**Vector.** Dependency typosquat, namespace hijack, or compromised upstream injects malicious code into our build.

**Impact.** Code execution in Cloud or in shipped clients.

**Mitigations.**
- Lockfiles + pinned versions + provenance verification where possible.
- CI dependency audit + secret-scan + CodeQL/Semgrep.
- Trivy on container images; pinned digest base images.
- HuggingFace model artifacts validated by hash; Cosign on our own outputs.
- Annual penetration test scope includes supply chain.

### T6. Connector OAuth token theft

**Vector.** Attacker obtains a user's connector token (Slack, Notion, etc.) via compromised DB row, log leak, or in-transit interception.

**Impact.** Read/write access to the user's third-party account.

**Mitigations.**
- Restricted-class storage with KMS-encrypted envelope + AAD scoped to user+grant ([10](../../POLICIES/10-data-classification.md), [24](../../POLICIES/24-plugin-connector-trust.md)).
- No tokens in logs (OTel collector redaction).
- Scope-minimization at OAuth grant.
- User-revocable + emergency-revoke broadcast capability.
- Audit-event per use.

### T7. Training-data leakage at rest

**Vector.** Training datasets contain class-C customer data and the storage is misconfigured (public bucket, exported snapshot).

**Impact.** Customer privacy breach.

**Mitigations.**
- Default-deny on bucket policies; IaC enforces private.
- Encryption-at-rest with managed CMK.
- Quarterly bucket audit for public visibility.
- DEK-destroy on dataset retirement.

### T8. AI-authored code introducing logic bugs in security-critical paths

**Vector.** An AI commit introduces a subtle bug in billing math, auth, KMS use, or plugin trust verification.

**Impact.** Silent confidentiality / integrity loss.

**Mitigations.**
- Human review required ([16](../../POLICIES/16-secure-development.md)).
- Security-critical paths require Security Lead sign-off (CODEOWNERS).
- Property-based tests on billing math.
- Quarterly PR audit samples include AI-attributed commits.

### T9. Auto-update / mobile distribution tampering

**Vector.** Compromised auto-update channel ships malicious binary to existing installs.

**Impact.** Code execution on user devices.

**Mitigations.**
- Code signing (Apple Developer ID, Microsoft Authenticode, Sigstore for Linux).
- Update manifest signed with publisher key.
- TLS pinning for update endpoint where feasible.

### T10. Cloud monetization arithmetic error (PI1)

**Vector.** Bug in inference-markup / payout-share / redemption math produces non-deterministic or wrong amounts.

**Impact.** Financial integrity loss, reversal cost, customer trust.

**Mitigations.**
- All computation in use-cases, server-side; client displays DTO fields only (AGENTS.md commandments).
- Idempotent processing with audit trail.
- Daily reconciliation report.
- Property-based tests; high coverage required.
