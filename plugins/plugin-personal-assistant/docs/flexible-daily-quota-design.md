# Flexible daily quota routines

This document defines the durable contract for count-based daily routines such
as “25 pushups, three sets a day, whenever.” It keeps three structural concerns
separate:

- `LifeOpsCountPerDayCadence` owns the local-day target and allowed timing.
- `LifeOpsProgressEvent` is an append-only, idempotent increment against one
  materialized occurrence.
- `LifeOpsQuotaCheckInPolicy` contributes optional check-ins to the scheduling
  spine; it does not create another timer, runner, or reminder store.

## Active day and identity

The definition timezone owns the calendar boundary. The occurrence key is
`quota:<YYYY-MM-DD>:day`, resolved in that timezone. An `anytime` occurrence
spans the local day; a window-limited quota spans the union of its named
windows, but still has one occurrence and one aggregate. Existing compatible
timezone conversion owns DST gaps and repeated wall times.

Restart preserves identity because materialization reuses the stored key and
progress is reconstructed from durable events. The next local date gets a new
occurrence at zero. Partial expired days do not complete or award a streak.

A timezone or quota-shape edit is rejected while a nonterminal day has
progress. This prevents increments from silently moving dates, changing units,
or being pruned. Late increments against expired, skipped, or muted
occurrences are rejected; callers must target the current occurrence.

## Replay, concurrency, and correction

Each report carries an occurrence-scoped idempotency key (chat uses the message
ID). A database transaction locks the occurrence, derives the current sum, and
inserts at most the remaining quantity. Concurrent or replayed reports
therefore cannot lose progress or persist a sum above the target. Completion
uses the ordinary idempotent terminal path so streaks, rollups, website access,
and escalation resolution remain unified.

Events are append-only. The current mutation contract accepts positive
increments only. A correction must be a separately identified append-only
workflow; until that workflow is exposed, the action asks for confirmation and
does not guess a decrement. Skip is terminal and rejects later increments.
Snooze preserves progress and defers check-ins. Completion and day end
structurally suppress remaining same-day check-ins.

## Scheduling contribution points

Occurrence refresh schedules a revision-bound `checkin` item through
`@elizaos/plugin-scheduling`. The `quota_incomplete` gate reads authoritative
definition and occurrence projections and denies stale or disabled policies,
completion, skip, expiry, mute, or rollover. It defers snoozed items and items
that have not entered an allowed owner-local window. The built-in quiet-hours
gate may defer again, after which the quota gate revalidates the active window.

`quota_complete` is registered on the same runner. The normal no-reply state
machine consumes bounded retry policy and expires silence without treating it
as task completion. Owner-facing copy is composed from the stored projection
immediately before dispatch, so it cannot carry a stale count.

These are Personal Assistant registry contributions. The scheduling package
stays storage- and domain-agnostic and never imports LifeOps.

## Projection and compatibility

Each `LifeOpsOccurrenceView` has required `progress`: null for non-quota
cadences, otherwise server-computed completed, target, remaining, unit, and
per-occurrence work. Overview, todos, providers, actions, and check-ins render
the server projection instead of recomputing business state.

`times_per_day` remains the fixed-slot contract and is selected only when the
owner names wall-clock times. Existing daily, weekly, interval, once, window,
and across-occurrence progression semantics remain unchanged. A bare daily
count is extracted as `count_per_day`; no wall-clock slot or hidden deadline is
synthesized.

## Release evidence

Release evidence must include the exact natural-language setup and persisted
definition, occurrence, progress events, scheduled item, state log, and
rollup; 0/3 through 3/3 replies; replay and concurrent increments; skip,
snooze, partial, late-log, timezone-edit, restart, and next-day behavior;
quiet-hours deferral, no-reply backoff, completion suppression, and fixed-slot
regressions. Agent behavior needs a real-model trajectory. Delivery needs real
runner claim/fire/dispatch logs plus accepted-surface receipt. Deterministic
and PGlite tests support but do not replace those artifacts.
