# @elizaos/corpus-tools

Private personal-corpus interchange schema and validators for #14748. The
package normalizes source collectors into `CorpusMessage` JSONL shards, validates
manifest integrity, and maps synthetic or scrubbed rows into the mock shapes used
by Gmail and the LifeOps simulator.

Raw and intermediate owner data belongs under `packages/corpus-tools/data/`,
which is ignored by the repo-wide `**/data/` rule. Only synthetic fixtures under
`fixtures/` are committed.

## CLI

```bash
bun run --cwd packages/corpus-tools validate -- fixtures/synthetic
bun run --cwd packages/corpus-tools corpus:scrub -- --target data --stage all --mode deep --resume
bun run --cwd packages/corpus-tools corpus:scrub -- --target data --stage llm --mode fast-track --dry-run
```

The validator accepts either a shard file or a directory of `*.jsonl` shards and
prints a JSON summary. It fails non-zero on schema, cutoff, duplicate-id,
reply-reference, thread-reference, or manifest-integrity errors.

The scrub driver writes its local-only ledger, output, and report under
`<target>/.state/` by default. Keep generated outputs there or outside the input
tree; a top-level `*.jsonl` beside platform shards is treated as corpus input by
the validator. `--resume` reuses content-hash + ruleset-version markers from
`scrub-ledger.jsonl`, so rerunning unchanged input should report zero stage
executions and a ledger hit rate of `1`.

Stage `mine` also emits `candidates.jsonl`, `candidate-frequency.json`, and
`candidate-review.csv` under `.state/`. Candidate rows carry source references
and salted value hashes; replacement identity is intentionally deferred to the
context/pseudonym-consistency pass so this deterministic stage never forks the
corpus-wide mapping.

Stage `secrets` permanently replaces high-confidence credentials and
secret-shaped tokens with typed placeholders such as
`[[SECRET:openai-key:1a2b3c4d5e6f]]`. Placeholder ids are salted by the
ruleset version and stable across reruns. Local `.env*` files beside the target
are used only as known-secret seeds; their raw values are not written to reports.
The driver refuses `rewrite` and `llm` unless the local ledger contains a green
`secrets` record for each message, so off-device stages cannot run on raw
credentials by accident.

Stage `rewrite` runs only in `deep` mode. It replaces gray-area named specifics
such as employers, projects, cities, and events with stable fictional
equivalents while preserving the surrounding message structure; `fast-track`
mode records an explicit skip. The current package-local implementation is the
deterministic contract harness for the model-backed Cerebras pass, so live
Cerebras proof still requires `CEREBRAS_API_KEY`.

## X Mapping

The canonical schema includes platform `x`. The existing LifeOps simulator
channel vocabulary does not include an X connector, so
`toLifeOpsSimulatorChannelMessage()` maps X rows to a telegram-shaped generic
channel by default and prefixes the thread name with `X: `. This is deliberately
contained inside the mapper; the canonical row keeps `platform: "x"`.
