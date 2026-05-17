# Voice Profiles — Implementation Notes

This directory is a **scaffold only**. The store interface, in-memory store, diarization pipeline interface, owner-confidence scoring, challenge service, and naive nickname evaluator are real and tested. Everything below has to land before any of this is wired into a shipping product.

## Diarization

- Target: pyannote-audio v3 segmentation + speaker-diarization pipeline.
- Run offline on captured clips; do not stream in v1.
- The `DiarizationPipeline` interface returns segments by ms; production must also expose a per-segment embedding so we can match against `VoiceProfileStore.search` without re-embedding the audio.

## Embeddings

- ECAPA-TDNN from SpeechBrain (`speechbrain/spkrec-ecapa-voxceleb`) is the working target.
- Vectors are 192-dim float32. Store the full vector in durable storage; the `vectorPreview` in `VoiceEmbeddingSummary` exists for fast in-memory similarity ranking and for safe redaction.
- L2-normalize before storage so cosine and dot product agree.

## Durable storage

- The `InMemoryVoiceProfileStore` is for tests only. Production needs:
  - PGlite (desktop) / SQLite (mobile) backing table with binary blob column for the full embedding.
  - An append-only audit log: every upsert/delete must be recorded with `actor`, `reason`, `timestamp`.
  - Backup + opt-in sync via the Cloud sync surface (separate workstream).

## Owner confidence

- The current `scoreOwnerConfidence` weighting is **deliberately conservative**: explicit signals (recent auth, passed challenge) dominate voice similarity. Tuning belongs with the threat-model write-up.
- Voice similarity alone must **never** authorize a protected action. The response gate (in `ambient-audio/`) uses owner confidence to decide *whether to respond*, not to decide *what authority the speaker has*.

## Protected actions and challenges

- `InMemoryChallengeService` hashes answers with SHA-256. Production must use a salted KDF (Argon2id) per-challenge and store nothing recoverable.
- Challenge prompts should pull from the owner's private fact set (memory-resident, never logged). Open question: who owns that fact set? Almost certainly the agent's owner-facts evaluator (Workstream J extension), which is **not** in this scaffold.
- Rate-limit verify attempts. The in-memory implementation does not — production must.

## Nicknames

- The naive regex-based evaluator is sufficient to bootstrap. Replace with a small classifier once we have labeled transcripts.
- Proposals must go through a dedupe step against existing owner facts before persistence.

## Threat model — must write before ship

1. Voice cloning / replay attack against the owner challenge.
2. Embedding leakage via the `vectorPreview` field (the preview is intentionally lossy but must be sized to defeat reconstruction).
3. Household profile vs owner-only profile escalation.
4. Long-term embedding drift (owner voice changes; profile re-enrollment cadence).
5. Cross-device profile sync — when, with what consent, and with what key.

## Out of scope here

- The voice-classifier, turn-intl, diarizer-* directories owned by the swarm. Their work feeds into this surface; we wire it up after their interfaces stabilize.
