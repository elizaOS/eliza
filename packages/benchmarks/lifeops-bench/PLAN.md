# LifeOpsBench trusted-evidence execution plan

This document is the operator runbook for evidence-gated LIVE scenarios. The
benchmark process, receipt signer, and native elizaOS runtime are separate
processes so the evaluated agent cannot mint its own evidence.

## Current implementation

The production signer registers all 48 base contracts plus the 5 uninstructed
catalog variants (53 registry entries). Each contract maps its two assertions
to two exact typed artifacts. Only server-owned provider-state capture or a
registered native evaluator may assemble a terminal snapshot; action-authored
`terminalSnapshot` data is discarded. The evaluator validates snapshot schema,
lineage digest, observation times, source provenance, fact schemas, artifact
hashes, and snapshot hash without accepting assertion IDs or scenario prose
from the request or runtime result.

Seven cases have native evaluators:

- `G10` reads the existing `CALENDAR_SOURCES/list` provider snapshot.
- `G15` validates school-source correction through `SCHOOL_SOURCES`.
- `G30` and `G38` validate household state through
  `HOUSEHOLD_OPERATIONS`.
- `G34` validates household-wide care math through `OWNER_FINANCES`.
- `G35` and `G36` validate structured parenting decisions plus post-action
  knowledge-graph, household, and owner-fact read-backs.

These evaluator implementations remain unit-testable over server-captured
objects, but the current HTTP runtime cannot release them as trusted evidence.
Its closed v1 provenance union is either
`local_nonpublishable/not_applicable` or
`provider_backed/not_verified`, always with `release_evidence: false`. The
Python connector validates those exact structures and fails closed until a
future server-owned provider readback is verifiable. Explicit provider
configuration alone is not evidence.

The remaining cases receive only a nonterminal operation receipt until a
server-owned capture or native evaluator proves their typed postconditions, so
generic handler success cannot satisfy the benchmark. Protocol fixtures,
deterministic connectors, PerfectAgent, LifeWorld, and the ordinary TypeScript
benchmark server are conformance tools. They cannot satisfy a trusted-evidence
requirement.

## Three-process deployment

Generate two distinct HMAC keys once and export the same values to the signer
and benchmark processes:

```bash
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_HMAC_KEY_B64="$(openssl rand -base64 32)"
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_RECEIPT_HMAC_KEY_B64="$(openssl rand -base64 32)"
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_KEY_ID=request-key-v1
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_RECEIPT_KEY_ID=receipt-key-v1
```

Start the dedicated runtime. Its token must differ from the evaluated agent's
benchmark token:

```bash
export ELIZA_BENCH_TRUSTED_RUNTIME_TOKEN="$(openssl rand -hex 32)"
export ELIZA_BENCH_TRUSTED_RUNTIME_ALLOWED_ACTIONS=CALENDAR_SOURCES
export ELIZA_BENCH_TRUSTED_RUNTIME_PORT=3941
bun run --cwd packages/lifeops-bench trusted-runtime:server
```

Start the independent receipt signer with durable replay state:

```bash
export LIFEOPS_BENCH_TRUSTED_RUNTIME_URL=http://127.0.0.1:3941
export LIFEOPS_BENCH_TRUSTED_RUNTIME_TOKEN="$ELIZA_BENCH_TRUSTED_RUNTIME_TOKEN"
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_REPLAY_DB=/absolute/path/to/trusted-replay.sqlite
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_PROVIDER=local_nonpublishable
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_BOUNDARY=local_nonpublishable
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_PORT=3942
python3 -m eliza_lifeops_bench.trusted_executor_cli
```

Run the benchmark from a third process with the evaluated agent's credentials,
the two HMAC verification keys, and no runtime bearer token:

```bash
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_URL=http://127.0.0.1:3942/execute
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_ALLOWED_PROVIDERS=local_nonpublishable
export LIFEOPS_BENCH_TRUSTED_EXECUTOR_ALLOWED_BOUNDARIES=local_nonpublishable
python3 -m eliza_lifeops_bench \
  --agent eliza \
  --scenario m1.g10.partial_calendar_failure
```

The built-in signer authenticates requests with HMAC. A bearer token is only
needed when an operator places an additional authenticated reverse proxy in
front of it. Plain HTTP is restricted to loopback.
This loopback example is explicitly local and non-publishable. A publishable
run requires a genuinely provider-backed capture, truthful provider/boundary
identifiers, verified server-owned readback provenance, and the complete
evidence review below.

## Acceptance evidence

A passing provider run must retain and manually review:

- the scenario result JSON and raw simulated-user/judge trajectory;
- the native runtime structured log showing `CALENDAR_SOURCES/list`;
- the signed terminal `lifeops.trusted-evidence.v3` receipt;
- the terminal assertion artifact and the provider source snapshot it hashes;
- a screenshot and short walkthrough video of the populated provider state and
  result viewer.

The receipt must bind the run nonce, request ordinal, action digest, scenario,
contract version/hash, provider, boundary, payload digest, artifact digest, and
the complete assertion set. Missing, stale, replayed, malformed, wrong-provider,
or nonterminal evidence fails closed.

The exact remaining semantic and provider-evidence coverage is tracked in
[`LIFEOPS_BENCH_GAPS.md`](./LIFEOPS_BENCH_GAPS.md); the complete corpus inventory
is in [`CORPUS_AUDIT.md`](./CORPUS_AUDIT.md).
