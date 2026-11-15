// One coordinator's durable replay expiry cursor. A full page commits a
// continuation alarm and a minimum deadline. Foreground writes can interleave.
module OnboardingReplayCleanup {
  type State = {
    now: int,
    expiries: int -> int,
    alarm: int,
    cursor: int,
    earliest: int,
    scanningStep: bool
  }
  pure val Keys = Set(0, 1, 2)
  pure val Deadlines = Set(1, 2, 3, 4, 5)
  var s: State

  pure def earlier(a: int, b: int): int = if (a == 0 or b < a) b else a
  action init = s' = {
    now: 0, expiries: Map(0 -> 0, 1 -> 0, 2 -> 0),
    alarm: 0, cursor: -1, earliest: 0, scanningStep: false
  }

  action publish(key: int, deadline: int): bool = all {
    deadline > s.now,
    s.expiries.get(key) <= s.now,
    s' = { ...s, expiries: s.expiries.set(key, deadline),
      alarm: earlier(s.alarm, deadline),
      earliest: if (s.cursor >= 0) earlier(s.earliest, deadline) else 0,
      scanningStep: false }
  }

  pure def nextKey(x: State): int = Keys
    .filter(key => key > x.cursor and x.expiries.get(key) != 0)
    .fold(3, (best, key) => if (key < best) key else best)

  action sweep = {
    val key = nextKey(s)
    all {
      s.alarm != 0 and s.alarm <= s.now,
      s' = if (key == 3) { ...s, alarm: s.earliest, cursor: -1,
          earliest: 0, scanningStep: true }
        else {
          val deadline = s.expiries.get(key)
          { ...s, cursor: key, alarm: if (s.now == 9) 9 else s.now + 1, scanningStep: true,
            expiries: if (deadline <= s.now) s.expiries.set(key, 0) else s.expiries,
            earliest: if (deadline > s.now) earlier(s.earliest, deadline) else s.earliest }
        }
    }
  }

  action tick = all { s.now < 9, s' = { ...s, now: s.now + 1, scanningStep: false } }
  action idle = s' = s
  action step = any {
    sweep, tick, idle,
    nondet key = Keys.oneOf()
    nondet deadline = Deadlines.oneOf()
    publish(key, deadline)
  }

  val AlarmOwnsReplay = all {
    (s.cursor >= 0).implies(s.alarm > 0),
    Keys.forall(key => {
      val deadline = s.expiries.get(key)
      (deadline > 0).implies(s.alarm > 0 and (s.cursor >= 0 or s.alarm <= deadline))
    })
  }
  temporal FreshEntriesSurvive = always((
    next(s.scanningStep).implies(Keys.forall(key =>
      (s.expiries.get(key) > s.now).implies(next(s.expiries.get(key)) == s.expiries.get(key))))).orKeep(s))
  temporal ExpiresEventually = Keys.forall(key =>
    (s.expiries.get(key) > 0 and s.expiries.get(key) <= s.now)
      .leadsTo(s.expiries.get(key) == 0 or s.expiries.get(key) > s.now))
  temporal FairExpiry = (sweep.weakFair(s) and tick.weakFair(s)).implies(ExpiresEventually)

  run replayBehindCursorKeepsAlarmTest = init.then(publish(2, 1)).then(tick).then(sweep)
    .then(publish(0, 4)).then(tick).then(sweep)
    .expect(s.expiries.get(0) == 4 and s.cursor == -1 and s.alarm == 4)
  run fullPagesRetainNextScanTest = init.then(publish(0, 1)).then(publish(2, 1))
    .then(tick).then(sweep).expect(s.cursor == 0 and s.alarm == 2)
    .then(tick).then(sweep).expect(s.cursor == 2 and s.alarm == 3)
    .then(tick).then(sweep).expect(s.cursor == -1 and s.alarm == 0)
  run expiredReplayCanBeRepublishedTest = init.then(publish(0, 1)).then(tick)
    .then(sweep).then(publish(0, 4)).then(tick).then(sweep)
    .expect(s.expiries.get(0) == 4 and s.alarm == 4)
}
