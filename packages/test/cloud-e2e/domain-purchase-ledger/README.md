# Domain purchase ledger

`ledger.jsonl` (created on the first paid run) is the append-only record of
every real domain the live e2e lane (`tests/domain-purchase.real.spec.ts`)
attempted or completed buying — Cloudflare registrations are non-refundable,
so this directory is deliberately **not** gitignored: commit the ledger after
a paid run as spend evidence.

One JSON object per line, phases `attempt` → `purchased`/`buy-failed` →
`detached`/`detach-failed`. Schema: `DomainLedgerEntry` in
`../src/helpers/domain-purchase.ts`.

Inspect:

```bash
bun run --cwd packages/test/cloud-e2e domains:ledger
```

Full semantics: [`../docs/domain-purchase-live.md`](../docs/domain-purchase-live.md).
