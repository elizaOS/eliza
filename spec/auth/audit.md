# Identity audit log

The identity service records every security-relevant event (sign-in, factor
and method changes, tenant changes, revocations) in an append-only audit
log. Each row carries the digest of the row before it, appends are
serialized so that two writers can never chain to the same predecessor, and
a checkpoint seals a contiguous prefix of the log, so that a verifier can
show the log was not rewritten. The digest here stands for the keyed hash
the service computes over a row's sequence number and content.

New in v4, from develop `src/server/db/audit-chain.ts`.

## Story: Show that the identity audit log was not altered

> As an operator of a branded deployment, I want to show that the record of
> who signed in and what changed is complete and untouched.

### Each audit row chains the digest of the row before it

```quint
type AuditRow = { seq: int, content: int, prev: int }
type Checkpoint = { upTo: int, head: int }
type ChainCursor = { ok: bool, digest: int, seq: int }
pure val chainStart: ChainCursor = { ok: true, digest: 0, seq: 0 }
type AuditLog = { rows: List[AuditRow], appending: int, waiting: List[int], checkpoints: List[Checkpoint] }
pure val initial: AuditLog = { rows: List(), appending: 0, waiting: List(), checkpoints: List() }
pure def digestOf(row: AuditRow): int = row.seq * 1000 + row.content
pure def headDigest(rows: List[AuditRow]): int = if (rows.length() == 0) 0 else digestOf(rows.nthOr(rows.length() - 1, { seq: 0, content: 0, prev: 0 }))
pure def chained(rows: List[AuditRow]): bool =
  rows.foldl(chainStart, (acc, r) => { ok: acc.ok and r.prev == acc.digest and r.seq == acc.seq + 1 and r.content >= 0 and r.content < 1000, digest: digestOf(r), seq: r.seq }).ok
pure def alwaysRowsChain(s: AuditLog): bool = chained(s.rows)
pure def sometimesThreeRowsChained(s: AuditLog): bool = s.rows.length() >= 3
```

### Concurrent appends are serialized

A writer waits for the append lock, reads the head, and appends behind it
while it holds the lock.

```quint
pure def canRequestAppend(s: AuditLog, writer: int): bool = writer > 0 and s.appending != writer and not(s.waiting.includes(writer))
pure def requestAppend(s: AuditLog, writer: int): AuditLog = { ...s, waiting: s.waiting.append(writer) }
pure def canTakeLock(s: AuditLog): bool = s.appending == 0 and s.waiting.length() > 0
pure def takeLock(s: AuditLog): AuditLog = { ...s, appending: s.waiting.nthOr(0, 0), waiting: s.waiting.tail() }
pure def canAppendRow(s: AuditLog, writer: int, content: int): bool = s.appending == writer and writer > 0 and content >= 0 and content < 1000
pure def appendRow(s: AuditLog, writer: int, content: int): AuditLog =
  { ...s, rows: s.rows.append({ seq: s.rows.length() + 1, content: content, prev: headDigest(s.rows) }), appending: 0 }
pure val writerValues = Set(1, 2)
pure val contentValues = Set(7, 8)
pure def alwaysOneAppenderAtATime(s: AuditLog): bool = not(s.waiting.includes(s.appending)) and s.waiting.every(w => w > 0 and s.waiting.select(o => o == w).length() == 1)
pure def stepAppendAddsOneRowBehindTheHead(before: AuditLog, after: AuditLog): bool =
  after.rows.length() == before.rows.length() or (after.rows.length() == before.rows.length() + 1 and after.rows.select(r => r.seq <= before.rows.length()) == before.rows)
pure def sometimesWriterWaits(s: AuditLog): bool = s.appending > 0 and s.waiting.length() > 0
```

### A checkpoint seals a contiguous prefix of the log

```quint
pure def checkpoint(s: AuditLog): AuditLog = { ...s, checkpoints: s.checkpoints.append({ upTo: s.rows.length(), head: headDigest(s.rows) }) }
pure def prefix(rows: List[AuditRow], n: int): List[AuditRow] = rows.select(r => r.seq <= n)
pure def alwaysCheckpointsCoverAPrefix(s: AuditLog): bool =
  s.checkpoints.every(c => c.upTo >= 0 and c.upTo <= s.rows.length() and c.head == headDigest(prefix(s.rows, c.upTo)))
pure def sometimesCheckpointBehindHead(s: AuditLog): bool = s.checkpoints.some(c => c.upTo > 0 and c.upTo < s.rows.length())
```
