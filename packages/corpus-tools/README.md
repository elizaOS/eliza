# @elizaos/corpus-tools

Private personal-corpus interchange schema, validators, and archive collectors
for #14747. The package normalizes source exports into `CorpusMessage` JSONL
shards and validates manifest integrity.

Raw and intermediate owner data belongs under `packages/corpus-tools/data/`,
which is ignored by the repo-wide `**/data/` rule. Only synthetic fixtures
under `fixtures/` are committed.

## X archive collector

`collectXArchive` (`src/collectors/x-archive.ts`) parses the official X data
archive — either the downloaded ZIP or an extracted directory — and writes
validated monthly shards plus `manifest.json` and `x-archive-summary.json`:

```ts
import { collectXArchive } from "@elizaos/corpus-tools";

const result = await collectXArchive({
  archivePath: "data/raw/x/archive.zip",
  ownerAccountId: "<numeric X account id>",
  ownerDisplay: "Owner Name",
  outDir: "data",
});
```

Tweets map to direction `out` with the thread id resolved to the reply-chain
root; DMs map per conversation with direction derived from the sender versus
the owner id; rows before the corpus cutoff (`2024-07-05`) are dropped. Likes
carry no timestamps in the archive, so they are counted in the summary and
never emitted as message rows. Re-running is idempotent: unchanged shards are
reused, missing shards are rewritten.

```bash
bun run --cwd packages/corpus-tools test
bun run --cwd packages/corpus-tools typecheck
```
