// A device syncs sleeping rows to POST /api/lifeops/schedule/observations
// (plugins/plugin-personal-assistant/src/routes/lifeops-routes.ts), which
// calls ingestScheduleObservations
// (src/lifeops/domains/reminders-service.ts). recordFromSyncInput
// (src/lifeops/schedule-state.ts) buckets every row time with bucketIso: the
// window start and the snapshot's sleep start are floored to the 30-minute
// bucket, the window end is rounded up and the snapshot's last-active time is
// rounded to the nearest bucket. The row is upserted by an id that includes
// its bucketed start, so a later sync in the same bucket replaces the row.
// Times are minutes after 05:00 UTC on 2026-11-01 in America/New_York, the
// night clocks fall back: at 06:00 UTC local time goes from 02:00 EDT back to
// 01:00 EST, so local 01:00 to 02:00 happens twice. Each sync carries one
// sleeping row that starts at the sync and lasts RowMinutes.
module ScheduleBucketRepeatedHour {
  pure val Bucket = 30
  pure val FallBack = 60
  pure val RowMinutes = 15
  pure val MaxSyncs = 4
  pure val LastSync = 110
  pure val NoSync = -1

  type Row = {
    start: int,
    end: int,
    sleepStart: int,
    lastActive: int,
    observed: int,
  }

  // Minutes after 05:00 UTC of the newest sync, NoSync before the first.
  var now: int
  // A sync at now was sent and has not been stored yet.
  var pending: bool
  // Stored rows of this device, one per bucketed start.
  var rows: Set[Row]
  // Sync instants that have been stored.
  var synced: Set[int]
  // Syncs that have been stored.
  var syncs: int

  // Local wall-clock minutes after 00:00 on 2026-11-01. Before the repeat
  // the clock reads EDT (UTC-4), from the repeat on it reads EST (UTC-5).
  pure def local(t: int): int = if (t < FallBack) t + 60 else t
  // The instant that starts t's local bucket.
  pure def floorB(t: int): int = t - local(t) % Bucket
  // The first local bucket boundary at or after t.
  pure def ceilB(t: int): int =
    if (local(t) % Bucket == 0) t else floorB(t) + Bucket
  // The closest local bucket boundary; a tie rounds up.
  pure def nearestB(t: int): int =
    if (2 * (local(t) % Bucket) >= Bucket) floorB(t) + Bucket else floorB(t)
  // The stored row of a sync at t.
  pure def syncRow(t: int): Row = {
    start: floorB(t),
    end: ceilB(t + RowMinutes),
    sleepStart: floorB(t),
    lastActive: nearestB(t),
    observed: t,
  }
  pure def upsert(rs: Set[Row], r: Row): Set[Row] =
    rs.filter(x => x.start != r.start).union(Set(r))

  action init = all {
    now' = NoSync,
    pending' = false,
    rows' = Set(),
    synced' = Set(),
    syncs' = 0,
  }
  // The device sends a row: the first at 01:30, 01:45 or 01:50 EDT, later
  // ones 10, 15 or 20 minutes after the previous one.
  action send = {
    nondet first = Set(30, 45, 50).oneOf()
    nondet gap = Set(10, 15, 20).oneOf()
    val at = if (now == NoSync) first else now + gap
    all {
      not(pending),
      syncs < MaxSyncs,
      at <= LastSync,
      now' = at,
      pending' = true,
      rows' = rows,
      synced' = synced,
      syncs' = syncs,
    }
  }
  // The route stores the row under its bucketed start.
  action store = all {
    pending,
    now' = now,
    pending' = false,
    rows' = upsert(rows, syncRow(now)),
    synced' = synced.union(Set(now)),
    syncs' = syncs + 1,
  }
  // The route has not stored the row yet.
  action stutter = all {
    now' = now,
    pending' = pending,
    rows' = rows,
    synced' = synced,
    syncs' = syncs,
  }
  action step = any { send, store, stutter }

  val ModelState = {
    now: now,
    pending: pending,
    rows: rows,
    synced: synced,
    syncs: syncs,
  }
  val Settled = not(pending)
  temporal SettlesWithoutFairness = not(Settled).leadsTo(Settled)
  temporal Settles = store.weakFair(ModelState)
    .implies(SettlesWithoutFairness)

  // Every stored time sits on a local half-hour boundary.
  val RowsOnLocalBuckets = rows.forall(r => and {
    local(r.start) % Bucket == 0,
    local(r.end) % Bucket == 0,
    local(r.sleepStart) % Bucket == 0,
    local(r.lastActive) % Bucket == 0,
  })
  // A floored start lies at most one bucket before the row, never after it.
  val FloorWithinBucket = rows.forall(r => and {
    r.start <= r.observed,
    r.observed < r.start + Bucket,
    r.sleepStart == r.start,
  })
  // A rounded-up end is never before the row's end.
  val CeilNotBefore = rows.forall(r => and {
    r.observed + RowMinutes <= r.end,
    r.end < r.observed + RowMinutes + Bucket,
  })
  // A rounded last-active time moves by at most half a bucket.
  val NearestWithinHalf = rows.forall(r => and {
    2 * (r.observed - r.lastActive) < Bucket,
    2 * (r.lastActive - r.observed) <= Bucket,
  })
  // A sync replaces only the row of its own bucket: every bucket that was
  // synced keeps one row, holding its newest sync.
  val EveryBucketKept = and {
    rows.size() == synced.map(t => floorB(t)).size(),
    synced.forall(t => rows.exists(r => and {
      r.start == floorB(t),
      r.observed >= t,
    })),
  }
  val TypeOK = and {
    now == NoSync or now.in(0.to(LastSync)),
    syncs.in(0.to(MaxSyncs)),
    synced.size() == syncs,
    rows.size() <= syncs,
    syncs > 0 or rows == Set(),
  }
}
