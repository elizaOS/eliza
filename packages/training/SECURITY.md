# Training Pipeline — Security & SOC2 Controls

This document captures the SOC2-relevant controls implemented in
``packages/training`` and the human-in-loop steps the engineering team
must follow to keep training-pipeline access compliant.

It is the operator-facing companion to the audit notes in
``/tmp/soc2-audit/07-training-models.md``.

## Customer-data consent (SOC2 PI1.1-PI1.5, C1.1)

Every entry in [``datasets.yaml``](datasets.yaml) MUST declare
``consent_basis`` (one of ``synthetic`` / ``public_domain`` /
``licensed`` / ``opt_in_user_consent`` / ``internal_dogfood``). Sources
carrying customer or internal data also require
``consent_proof_uri`` pointing at the opt-in record or internal DPA.

The gate is enforced by
[``scripts/lib/dataset_loader.py``](scripts/lib/dataset_loader.py). Any
training script that consumes the registry — currently
``download_datasets.py``, and going forward every new script that loads
``datasets.yaml`` — MUST use ``load_registry()`` rather than calling
``yaml.safe_load`` directly.

### Nightly-trajectory opt-in

Sources ``eliza-nightly-*`` and ``nubilio-trajectories`` are tagged as
customer-data. The current ``consent_proof_uri`` points back to this
document because the production opt-in flow is still in design (see
"open items" below). The provisional control is:

  - Local-only ``~/.eliza/training/datasets/`` writes happen ONLY when
    ``ELIZA_DISABLE_TRAJECTORY_LOGGING`` is unset (default opt-in for
    dogfooders, will flip to opt-out once the consent UI ships).
  - The privacy filter runs ``--strict`` by default
    ([``scripts/privacy_filter_trajectories.py``](scripts/privacy_filter_trajectories.py)).
  - Nubilio data is internal-dogfood collected from a self-hosted bot the
    eliza team operates. No third-party user records are involved.

### Nubilio internal-dogfood

The ``nubilio-trajectories`` source is data collected from an internal
self-hosted Eliza instance the eliza team operates for dogfooding. No
third-party data is involved. The retention policy is "the lifetime of
the eliza-1 training cycle", and the dataset is rebuilt from scratch on
each cycle.

## Training-data lineage (SOC2 CC8.1, CC6.8)

Every published model artifact records a ``trainingDataManifestSha256``
field computed by
[``scripts/manifest/eliza1_manifest.py``](scripts/manifest/eliza1_manifest.py)
via ``compute_training_data_manifest_sha256``. The hash pins:

  - The byte-exact ``datasets.yaml`` snapshot used during the run.
  - The sha256 of every normalized per-source JSONL fed to the trainer.

Downloaders can recompute the hash and re-run the CLI:

```bash
python -m manifest.eliza1_manifest \
    --verify path/to/training-data-manifest.json \
    --datasets-yaml path/to/datasets.yaml
```

## Model-artifact signing (SOC2 CC6.8)

Every GGUF published to ``elizaos/eliza-1`` is signed with an Ed25519
key managed by ``@elizaos/security``'s KMS adapter. The signing tool
lives at
[``packages/security/scripts/kms-sign.ts``](../security/scripts/kms-sign.ts);
``scripts/publish_eliza1_model.py`` invokes it just before pushing the
file to HuggingFace. The signature record (``model.gguf.sig.json``) and
raw bytes (``model.gguf.sig``) are uploaded alongside the GGUF.

Verifying downloaders run
[``scripts/verify_signature.py``](scripts/verify_signature.py), which
checks the signature against the embedded Ed25519 public key (no KMS
access required).

## DSPy optimized-prompt integrity (SOC2 CC6.8)

The runtime cache of native-optimizer artifacts in
``<stateDir>/optimized-prompts/<task>/`` is HMAC-protected by
[``packages/core/src/services/optimized-prompt.ts``](../core/src/services/optimized-prompt.ts).
Every artifact gets a ``.mac`` sidecar containing
``HMAC-SHA256(payload, key)``. On load, a missing or mismatched MAC
emits the ``optimized_prompt.integrity_failed`` audit action and the
runtime falls back to the baseline prompt.

The HMAC key is sourced from ``ELIZA_OPTIMIZED_PROMPT_HMAC_KEY`` in
production. The default fallback (a deterministic per-install tag) is
explicitly NOT secret-grade and is intended only for local-only dev
installs.

## Privacy filter — mandatory ``--strict``

``scripts/privacy_filter_trajectories.py`` defaults to ``--strict``.
Operators who must disable it pass ``--allow-non-strict`` and set
``ELIZA_TRAINING_PRIVACY_OVERRIDE_REASON=<non-empty reason>`` in the
environment. The reason is recorded on the privacy-filter stats and
attestation outputs and constitutes a SOC2 incident that must be
reviewed.

## Training credential broker (SOC2 CC6.1)

[``scripts/_creds.py``](scripts/_creds.py) is the single chokepoint for
``HF_TOKEN``, ``VAST_API_KEY``, ``AWS_ACCESS_KEY_ID`` /
``AWS_SECRET_ACCESS_KEY``. It:

  - Pulls from the env by default.
  - Optionally calls a Steward credential-proxy endpoint when
    ``ELIZA_STEWARD_CREDS_URL`` is set. The helper requests
    ``GET /v1/creds/:name`` and treats a ``200`` plaintext body as the
    credential; non-200, timeout, or network failure falls back to env.
  - Emits a ``creds.access`` audit log line on every resolution with the
    credential's last-4 + sha256 prefix — never the value.

### Rotation cadence

| Credential                                    | Cadence     | Owner          |
| --------------------------------------------- | ----------- | -------------- |
| ``HF_TOKEN`` (publish-only org account)       | every 90d   | Eliza ops      |
| ``VAST_API_KEY``                              | every 60d   | Eliza ops      |
| ``AWS_ACCESS_KEY_ID`` / ``..._SECRET_KEY``    | every 90d   | Eliza ops      |
| KMS root key (``ELIZA_KMS_PASSPHRASE``)       | every 365d  | Security team  |
| Optimized-prompt HMAC key                     | every 365d  | Security team  |

Rotations land in the secrets store first, then env files / CI secret
managers are updated, then a smoke publish (``--dry-run``) confirms the
audit-log line shows the new ``sha256_prefix``.

### Open items (human-in-loop)

  1. **End-user opt-in UI.** The trajectory-collection consent flow is
     not yet shipped in the desktop app. Until then, ``eliza-nightly-*``
     sources may only be used for internal dogfooding and the
     ``consent_proof_uri`` MUST be updated when the production UI lands.
  2. **Archive-grade consent-proof URIs.** Replace the temporary
     ``SECURITY.md#...`` anchors with permanent, archive-grade URIs once
     the legal review of the trajectory-collection DPA completes.
  3. **Steward credential-proxy.** Implement
     ``GET /v1/creds/:name`` against Steward and point production
     ``ELIZA_STEWARD_CREDS_URL`` at it.
  4. **Firmware signing.** Scaffolding lives in
     ``packages/chip/fw/signing/`` but no firmware blob has been signed
     yet; that needs the hardware-backed signing key to be provisioned.
