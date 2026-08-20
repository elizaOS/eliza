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

## Loader for mock and scenario consumers

`loadCorpusMessages` (`src/loader.ts`) is the read boundary for downstream
mocks: it validates a shard tree with the shared validator, applies a
platform/account/thread/window/cap selection with deterministic ts-then-id
ordering, and enforces a scrub floor that defaults to `verified` — unscrubbed
rows never reach a consumer unless a test explicitly loosens
`minScrubState`. Any validation issue aborts the load (`CorpusLoadError`)
rather than serving a partial corpus. The committed synthetic tree under
`fixtures/sample-corpus/` exercises the whole path in CI; the scenario-runner
Gmail mock consumes this loader via `ELIZA_CORPUS_DIR` /
`startMocks({ corpusDir })` (see
`packages/scenario-runner/test/mocks/scripts/google-gmail-corpus.ts`).

## Reviewed sensitive deletion

The two-phase deletion boundary never mutates raw source shards. `plan` binds a
strict JSON/YAML ruleset and candidate inventory to a deterministic local review
queue; `apply` requires a complete decision document for that exact queue and
writes a separate survivor corpus, zero-content tombstones, manifest, ledger,
approval, and sanitized report.

```bash
bun run --cwd packages/corpus-tools validate -- data/source
bun run --cwd packages/corpus-tools corpus:delete -- plan \
  --target data/source --candidates data/.state/candidates.jsonl \
  --rules data/delete-rules.yaml --queue data/.state/deletion-review.json \
  --normalized-rules data/.state/deletion-rules.normalized.json
bun run --cwd packages/corpus-tools corpus:delete -- apply \
  --target data/source --candidates data/.state/candidates.jsonl \
  --normalized-rules data/.state/deletion-rules.normalized.json \
  --queue data/.state/deletion-review.json \
  --decisions data/.state/deletion-decisions.json --output data/deleted \
  --ledger data/.state/deletion-ledger.jsonl \
  --manifest data/deleted/manifest.json \
  --approval data/.state/deletion-approval.json \
  --report data/.state/deletion-report.json
```

Rules and decisions are private owner inputs. Review every atomic group before
apply, retain only counts and hashes in shared evidence, and prove idempotent
re-apply plus stale-decision rejection against a protected snapshot before the
issue is closed.

## Telegram Desktop collector

`collectTelegramDesktopExport` parses the machine-readable `result.json`
created by Telegram Desktop's Settings → Advanced → Export Telegram data flow.
It is offline-only: the collector does not accept GramJS clients,
`StringSession` values, Telegram API credentials, or raw `tdata` directories.

```ts
import { collectTelegramDesktopExport } from "@elizaos/corpus-tools";

const result = await collectTelegramDesktopExport({
  exportPath: "data/raw/telegram/result.json",
  ownerAccountId: "<numeric Telegram user id>",
  outDir: "data",
  allowedGroupPeerIds: ["<explicitly selected group id>"],
  allowedChannelPeerIds: ["<explicitly selected channel id>"],
});
```

DMs are admitted by default; groups and channels are denied unless their bare
peer ids are allowlisted. Rows are bounded to the canonical corpus
cutoff/anchor, identities include account + peer kind + peer id + message id,
and monthly shards plus the manifest and aggregate summary are byte-stable on
rerun. Service, deleted, secret-chat, and media-only records are counted but
not fabricated into text messages. Export media paths are never opened, so
metadata alone never produces an attachment SHA-256.

Telegram's `verification_codes` dialog is always excluded and counted as
credential material. Input is capped at 64 MiB and read only through that byte
boundary before parsing. Symlinked or hardlinked inputs, duplicate JSON object
keys, and files changed during capture are rejected. Publications use an
output-root lock, account-owned
`telegram/<account>/summary.json` files, and a manifest installed last as the
generation commit marker. Before the first changed or stale shard is installed,
an existing marker is removed so an interrupted update is visibly incomplete;
unchanged reruns retain it byte-for-byte. Collector-owned hardlinks, concurrent
writers, and manifest validation issues fail the collection instead of
returning partial success.

Migrated basic-group history retains Telegram Desktop's signed negative message
and reply ids; account and peer identities remain positive-only. Collection
currently fails closed on Windows because Node's portable filesystem API cannot
both reject directory reparse points and establish owner-only ACLs for these raw
private-message artifacts. Windows support requires platform-specific ACL and
reparse-point enforcement plus real-host verification.

```bash
bun run --cwd packages/corpus-tools test
bun run --cwd packages/corpus-tools typecheck
```
