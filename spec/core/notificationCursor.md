# Native notification pagination

The source is `packages/core/src/services/notification.ts` and `quint/NativeNotificationCursor.qnt` at the pinned baseline. The inbox owns rows and append sequence in [Notifications](./notifications.md). This machine owns only a client's captured scan fence and returned page. Every read supplies the current validated inbox snapshot, so replacement epochs, deletions and appended rows are observed without extending an existing fence.

## Story: Page a fixed notification snapshot without skipping unreadable rows

### A scan captures its epoch and upper append coordinate

The first page starts at zero and captures the current upper sequence. An incomplete page advances to its last returned coordinate. A complete page consumes the entire original fence, including deleted rows. An unreadable eligible head yields an explicit projection error and preserves the cursor.

```quint
type Cursor = { epoch: int, after: int, through: int }
type PageStatus = Unread | Ok | EpochChanged | Invalid | ProjectionError
type Scan = { cursor: Cursor, pageQuery: Cursor, returned: List[int], complete: bool, status: PageStatus }
pure val emptyCursor: Cursor = { epoch: -1, after: 0, through: 0 }
pure val initial: Scan = { cursor: emptyCursor, pageQuery: emptyCursor, returned: List(), complete: false, status: Unread }
pure val rowsValues = Set(List(), List(1), List(1, 2), List(1, 3), List(2, 3))
pure val epochValues = Set(0, 1)
pure val sequenceValues = Set(0, 1, 2, 3)
pure val blockedValues = Set(0, 1, 2, 3)
pure val limitValues = Set(1, 2)
pure val queryValues = Set({ epoch: 0, after: 0, through: 2 }, { epoch: 0, after: 1, through: 2 }, { epoch: 1, after: 0, through: 3 }, { epoch: 0, after: 4, through: 2 })
type Ordered = { valid: bool, previous: int }
type Prefix = { count: int, kept: List[int] }
pure def orderedRows(rows: List[int], sequence: int): bool = rows.foldl({ valid: true, previous: 0 }, (checked, id) => { valid: checked.valid and id > checked.previous and id <= sequence, previous: id }).valid
pure def prefixRows(rows: List[int], limit: int): List[int] = rows.foldl({ count: 0, kept: List() }, (prefix, id) => { count: prefix.count + 1, kept: if (prefix.count < limit) prefix.kept.append(id) else prefix.kept }).kept
pure def pageResult(query: Cursor, s: Scan, rows: List[int], epoch: int, sequence: int, blocked: int, limit: int): Scan = {
  val eligible = rows.select(id => id > query.after and id <= query.through)
  val returned = prefixRows(eligible, limit)
  val status = if (query.epoch != epoch) EpochChanged else if (query.after < 0 or query.after > query.through or query.through > sequence or limit <= 0 or not(orderedRows(rows, sequence))) Invalid else if (eligible.nthOr(0, 0) != 0 and returned.includes(blocked)) ProjectionError else Ok
  val complete = status == Ok and eligible.length() <= limit
  { cursor: if (status == Ok) { ...query, after: if (complete) query.through else returned.nthOr(returned.length() - 1, query.after) } else s.cursor, pageQuery: query, returned: if (status == Ok) returned else List(), complete: complete, status: status }
}
pure def begin(s: Scan, rows: List[int], epoch: int, sequence: int, blocked: int, limit: int): Scan = pageResult({ epoch: epoch, after: 0, through: sequence }, s, rows, epoch, sequence, blocked, limit)
pure def continuePage(s: Scan, rows: List[int], epoch: int, sequence: int, blocked: int, limit: int): Scan = pageResult(s.cursor, s, rows, epoch, sequence, blocked, limit)
pure def readCursor(s: Scan, query: Cursor, rows: List[int], epoch: int, sequence: int, blocked: int, limit: int): Scan = pageResult(query, s, rows, epoch, sequence, blocked, limit)
pure def alwaysReturnedRowsWithinFence(s: Scan): bool = s.status != Ok or s.returned.every(id => id > s.pageQuery.after and id <= s.pageQuery.through)
pure def alwaysIncompleteAdvances(s: Scan): bool = s.status != Ok or s.complete or (s.cursor.after > s.pageQuery.after and s.cursor.after <= s.pageQuery.through)
pure def alwaysCompleteConsumesFence(s: Scan): bool = s.status != Ok or not(s.complete) or s.cursor.after == s.pageQuery.through
pure def alwaysRejectedPagesAreEmpty(s: Scan): bool = s.status == Ok or (s.returned.length() == 0 and not(s.complete))
pure def stepFailedReadPreservesCursor(before: Scan, after: Scan): bool = after.status == Ok or after.cursor == before.cursor
pure def sometimesProjectionFailure(s: Scan): bool = s.status == ProjectionError
pure def sometimesEpochChangeRejected(s: Scan): bool = s.status == EpochChanged
pure def sometimesCompletedScan(s: Scan): bool = s.status == Ok and s.complete and s.cursor.through > 0
```
