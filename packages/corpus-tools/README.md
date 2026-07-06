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
```

The validator accepts either a shard file or a directory of `*.jsonl` shards and
prints a JSON summary. It fails non-zero on schema, cutoff, duplicate-id,
reply-reference, thread-reference, or manifest-integrity errors.

## X Mapping

The canonical schema includes platform `x`. The existing LifeOps simulator
channel vocabulary does not include an X connector, so
`toLifeOpsSimulatorChannelMessage()` maps X rows to a telegram-shaped generic
channel by default and prefixes the thread name with `X: `. This is deliberately
contained inside the mapper; the canonical row keeps `platform: "x"`.
