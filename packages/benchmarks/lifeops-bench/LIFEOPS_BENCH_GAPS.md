# LifeOpsBench semantic and evidence gaps

This inventory is generated from the 1,501 registered base scenarios. The machine source
of truth is [`corpus-audit.json`](./corpus-audit.json), regenerated with:

```bash
python3 -m eliza_lifeops_bench.corpus_audit --output corpus-audit.json
```

## LifeWorld semantic coverage

`noEffectGaps` is empty: every ground-truth action occurrence in the STATIC
corpus is either a modeled mutation, a classified no-mutation operation
(modeled reads, privacy-guard writes, policy writes, and conversational
termination), or an explicit typed failure.
Nothing can masquerade as a successful no-op, and there are zero unclassified
successful no-effects and zero audit execution errors.

Recognition in `_ACTION_HANDLERS` does not imply modeled behavior. New
scenarios must not target an operation until its real LifeWorld state,
mutations, result data, and adversarial tests are implemented; a regression
that reopens `noEffectGaps` fails `tests/test_corpus_audit.py`.

## Trusted provider evidence

The parent/caregiver suite declares 48 versioned receipt contracts plus 5
uninstructed catalog variants (G2, G8, G14, G19, G44 at contract version 2),
and all 53 are present in the production signer registry with server-owned
typed evaluators. Each contract requires two exact domain artifacts in a
terminal snapshot. Runtime data cannot provide assertion IDs: the signer maps artifact
kinds to assertions, checks typed facts and provenance, recomputes every
content hash, and binds the snapshot to the authenticated action lineage.

`G10` can currently satisfy its contract from the native
`CALENDAR_SOURCES/list` snapshot. `G15` has a native `SCHOOL_SOURCES`
evaluator; `G30` and `G38` have native `HOUSEHOLD_OPERATIONS` evaluators;
`G34` has a native `OWNER_FINANCES` evaluator; and `G35` and `G36` validate
structured parenting decisions plus post-action graph/repository read-backs.
These are the seven native cases. The remaining 41 base contracts are
schema-only and stay fail-closed until server-owned provider-state capture or a
native evaluator proves the exact typed postconditions. Action-authored
`terminalSnapshot` data is stripped; registry presence does not turn generic
action success, a protocol fixture, or a deterministic connector into provider
evidence.
The seven native evaluators are structural implementations, not currently
publishable HTTP evidence. Runtime provenance v1 exposes only
`local_nonpublishable/not_applicable` and
`provider_backed/not_verified`, both with `release_evidence: false`; the Python
connector rejects both until verified server-owned provider readback exists.
Provider configuration, local durable receipts, and `provider_accepted`
receipts without an outer-key-matched domain idempotency key cannot substitute
for that readback.
Confidential-sharing contracts still require authoritative policy artifacts,
writes require idempotent provider effect receipts, and recovery contracts
require a terminal snapshot proving that partial failure was surfaced rather
than hidden.

## Corpus fidelity boundaries

- All 757 LIVE and 744 publishable STATIC openings are independently
  model-generated from hidden goals. The ten edge runs per base add
  model-directed vagueness, referents, corrections, colloquial/noisy or
  code-switched language, underspecification, stress, relative time, and
  handoff context without changing the hidden goal.
- The 734 STATIC required-output contracts are semantic facts/outcomes graded
  once by the independent judge. Literal matching exists only in explicit
  non-publishable offline conformance.
- PerfectAgent, WrongAgent, fake backends, deterministic connectors, and fixed
  evaluator clients are test harnesses and are never reported as live evidence.
- STATIC fallback selection is model-driven when evaluator models are wired.
  Offline static conformance retains a punctuation gate and canned facts.
- The persona library covers adults across caregiver, elder, travel,
  shift-work, neurodivergence, low-activation, and communications contexts.
  It does not contain a direct child persona; child-related scenarios must keep
  guardian authority and consent explicit until a dedicated safe contract is
  designed.

See [`CORPUS_AUDIT.md`](./CORPUS_AUDIT.md) for the module/persona inventory and
the deterministic-protocol versus model-inference boundary audit.
