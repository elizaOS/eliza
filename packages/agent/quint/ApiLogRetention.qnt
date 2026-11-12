// server-state.ts appendApiLogEntries/findRecentInsufficientCreditsLog and
// chat-routes.ts normalizeChatResponseText. Five ordered entries, two retained
// newest entries and three clock epochs abstract the 60-second lookback.
// Classification and append are synchronous; the real HTTP hook checks strings.
module ApiLogRetention {
  pure val Entries = 0.to(4)
  var s: {
    next: int, now: int, history: Set[int], buffer: Set[int],
    credit: Set[int], stamp: int -> int, request: str,
    expectedCredit: bool, replyCredit: bool
  }
  pure def recent(ids: Set[int], credit: Set[int], stamp: int -> int, now: int): int =
    ids.filter(i => credit.contains(i) and now - stamp.get(i) <= 1)
      .fold(-1, (latest, i) => if (i > latest) i else latest)
  pure def retained(ids: Set[int], latest: int, keep: int): Set[int] =
    ids.filter(i => i >= keep).union(if (latest >= 0) Set(latest) else Set())
  action init = s' = {
    next: 0, now: 0, history: Set(), buffer: Set(), credit: Set(),
    stamp: Entries.mapBy(_ => -1), request: "idle",
    expectedCredit: false, replyCredit: false
  }
  action appendEntry(isCredit: bool): bool = all {
    s.next < 5,
    {
      val ids = s.buffer.union(Set(s.next))
      val credit = if (isCredit) s.credit.union(Set(s.next)) else s.credit
      val stamp = s.stamp.set(s.next, s.now)
      val latest = recent(ids, credit, stamp, s.now)
      s' = { ...s, next: s.next + 1, history: s.history.union(Set(s.next)),
        credit: credit, stamp: stamp,
        buffer: if (ids.size() > 3) retained(ids, latest, s.next - 1) else ids }
    }
  }
  action elapse = all { s.now < 2, s' = { ...s, now: s.now + 1 } }
  action requestReply = all { s.request == "idle", s' = { ...s, request: "pending" } }
  action reply = all {
    s.request == "pending",
    s' = { ...s, request: "answered",
      expectedCredit: recent(s.history, s.credit, s.stamp, s.now) >= 0,
      replyCredit: recent(s.buffer, s.credit, s.stamp, s.now) >= 0 }
  }
  action step = any { appendEntry(true), appendEntry(false), elapse, requestReply, reply, s' = s }
  val TypeOK = all {
    s.next >= 0, s.next <= 5, s.now >= 0, s.now <= 2,
    s.history == Entries.filter(i => i < s.next), s.buffer.subseteq(s.history),
    s.credit.subseteq(s.history), s.stamp.keys() == Entries,
    s.history.forall(i => s.stamp.get(i) >= 0 and s.stamp.get(i) <= s.now),
    s.request.in(Set("idle", "pending", "answered"))
  }
  val Bounded = s.buffer.size() <= 3
  val NewestRetained = s.history.filter(i => i >= s.next - 2).subseteq(s.buffer)
  val RecentCreditRetained = recent(s.history, s.credit, s.stamp, s.now) ==
    recent(s.buffer, s.credit, s.stamp, s.now)
  val FallbackPreserved = s.request == "answered" implies s.replyCredit == s.expectedCredit
  temporal ReplyWithoutFairness = (s.request == "pending").leadsTo(s.request == "answered")
  temporal ReplySettles = reply.weakFair(s).implies(ReplyWithoutFairness)

  // The count-only eviction from #39161 removed a still-recent warning.
  action legacyAppend = all {
    s.next < 5,
    {
      val ids = s.buffer.union(Set(s.next))
      s' = { ...s, next: s.next + 1, history: s.history.union(Set(s.next)),
        stamp: s.stamp.set(s.next, s.now),
        buffer: if (ids.size() > 3) ids.filter(i => i >= s.next - 1) else ids }
    }
  }
  run warningSurvivesBurstTest = init.then(appendEntry(true)).then(appendEntry(false))
    .then(appendEntry(false)).then(appendEntry(false)).then(appendEntry(false))
    .then(requestReply).then(reply).expect(Bounded and FallbackPreserved and s.replyCredit)
  run oldWarningExpiresTest = init.then(appendEntry(true)).then(elapse).then(elapse)
    .then(requestReply).then(reply).expect(FallbackPreserved and not(s.replyCredit))
  run newestWarningWinsTest = init.then(appendEntry(true)).then(appendEntry(true))
    .then(appendEntry(false)).then(appendEntry(false)).expect(RecentCreditRetained and s.buffer.contains(1))
  run countOnlyEvictionWitnessTest = init.then(appendEntry(true)).then(appendEntry(false))
    .then(appendEntry(false)).then(legacyAppend).expect(not(RecentCreditRetained))
}
