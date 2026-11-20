// The local schedule refresh (refreshLocalMergedScheduleState in
// plugins/plugin-personal-assistant/src/lifeops/domains/reminders-service.ts)
// asks the schedule insight for the next meal, stores the local observations
// (deriveLocalScheduleObservations in src/lifeops/schedule-state.ts) and then
// merges the device's recent rows (mergeScheduleObservations, same file).
// predictNextMeal (src/lifeops/schedule-insight.ts) opens a lunch window that
// is already in progress at the tick: it starts at now and lasts two hours.
// bucketSnapshot floors the window start to the 30-minute bucket and rounds
// the end up, and the meal row is upserted by its bucketed start.
// Times are minutes after 13:00 UTC; every tick lies inside the lunch hours.
// The merge takes the newest meal row (all rows carry the same lunch
// confidence) and keeps it while its start is not before the floored now.
// Otherwise it falls back to the newest snapshot that passes the same test;
// each row's snapshot carries the row's own window, so the fallback gives the
// same answer and is folded into one rule here.
module MergedMealWindow {
  pure val Bucket = 30
  pure val Window = 120
  pure val MaxTicks = 4
  pure val LastTick = 90
  pure val NoTick = -1
  pure val NoMeal = -1

  type Row = { start: int, end: int, observed: int }

  // Minutes after 13:00 UTC of the newest refresh, NoTick before the first.
  var now: int
  // A refresh at now was asked for and has not run yet.
  var pending: bool
  // Stored lunch rows of this device, one per bucketed start.
  var rows: Set[Row]
  // The merged next meal window, NoMeal when there is none.
  var mergedStart: int
  var mergedEnd: int
  // Refreshes that have run.
  var ticks: int

  pure def floorB(t: int): int = (t / Bucket) * Bucket
  pure def ceilB(t: int): int = ((t + Bucket - 1) / Bucket) * Bucket
  pure def newest(rs: Set[Row]): int =
    rs.fold(NoTick, (m, r) => if (r.observed > m) r.observed else m)
  // The stored row a refresh at t writes.
  pure def tickRow(t: int): Row =
    { start: floorB(t), end: ceilB(t + Window), observed: t }
  pure def upsert(rs: Set[Row], r: Row): Set[Row] =
    rs.filter(x => x.start != r.start).union(Set(r))
  // Rows the merge still counts as the next meal at t.
  pure def live(rs: Set[Row], t: int): Set[Row] =
    rs.filter(r => r.start >= floorB(t))

  action init = all {
    now' = NoTick,
    pending' = false,
    rows' = Set(),
    mergedStart' = NoMeal,
    mergedEnd' = NoMeal,
    ticks' = 0,
  }
  // The scheduler, the overview or a reminder read asks for a refresh: the
  // first one lands 0, 10 or 20 minutes into a bucket, later ones 10 or 20
  // minutes after the previous one.
  action request = {
    nondet first = Set(0, 10, 20).oneOf()
    nondet gap = Set(10, 20).oneOf()
    val at = if (now == NoTick) first else now + gap
    all {
      not(pending),
      ticks < MaxTicks,
      at <= LastTick,
      now' = at,
      pending' = true,
      rows' = rows,
      mergedStart' = mergedStart,
      mergedEnd' = mergedEnd,
      ticks' = ticks,
    }
  }
  // The refresh stores the tick's lunch row and merges the device's rows.
  action handle = {
    val stored = upsert(rows, tickRow(now))
    val kept = live(stored, now)
    val picked = kept.filter(r => r.observed == newest(kept))
    all {
      pending,
      now' = now,
      pending' = false,
      rows' = stored,
      mergedStart' =
        if (picked.size() == 0) NoMeal
        else picked.fold(NoMeal, (m, r) => r.start),
      mergedEnd' =
        if (picked.size() == 0) NoMeal
        else picked.fold(NoMeal, (m, r) => r.end),
      ticks' = ticks + 1,
    }
  }
  // The refresh has not run yet.
  action stutter = all {
    now' = now,
    pending' = pending,
    rows' = rows,
    mergedStart' = mergedStart,
    mergedEnd' = mergedEnd,
    ticks' = ticks,
  }
  action step = any { request, handle, stutter }

  val ModelState = {
    now: now,
    pending: pending,
    rows: rows,
    mergedStart: mergedStart,
    mergedEnd: mergedEnd,
    ticks: ticks,
  }
  val Merged = ticks > 0 and not(pending)
  val Settled = not(pending)
  temporal SettlesWithoutFairness = not(Settled).leadsTo(Settled)
  temporal Settles = handle.weakFair(ModelState)
    .implies(SettlesWithoutFairness)

  // After a refresh the merged state shows the lunch window that refresh
  // stored, wherever the tick falls inside its bucket.
  val CurrentWindowShown =
    not(Merged) or and {
      mergedStart == floorB(now),
      mergedEnd == ceilB(now + Window),
    }
  // The shown window is in progress: it began by now and has not ended.
  val ShownWindowOpen =
    not(Merged) or and { mergedStart <= now, mergedEnd > now }
  // A row from an earlier bucket never comes back as the next meal.
  val EarlierBucketDropped =
    not(Merged) or rows.forall(r =>
      r.start >= floorB(now) or r.start != mergedStart)
  val TypeOK = and {
    now == NoTick or now.in(0.to(LastTick)),
    ticks.in(0.to(MaxTicks)),
    rows.size() <= ticks,
    rows.forall(r => and {
      r.start % Bucket == 0,
      r.end % Bucket == 0,
      r.start <= r.observed,
      r.observed < r.end,
    }),
    ticks > 0 or (mergedStart == NoMeal and mergedEnd == NoMeal),
  }
}
