lemma RecentFilter(s: RateLimits, k: string)
  ensures recent(s, k) == ProofLib.Filter((e: RateEvent) => ((e.key == k) && (e.at > (s.now - windowLength))), s.events)
{}

lemma AttemptRecent(s: RateLimits, key: string, k: string)
  ensures |recent(attempt(s, key), k)| <= |recent(s, k)| + (if k == key && attempt(s, key).lastAdmitted then 1 else 0)
  ensures k == key && attempt(s, key).lastAdmitted ==> |recent(attempt(s, key), k)| <= maxRequests
  ensures forall e :: e in attempt(s, key).events ==> e in s.events || (e.key == key && attempt(s, key).lastAdmitted)
{
  var p0 := (e: RateEvent) => ((e.key != key) || (e.at > (s.now - windowLength)));
  var pruned := ProofLib.Filter(p0, s.events);
  var after := attempt(s, key);
  var fk := (e: RateEvent) => ((e.key == k) && (e.at > (s.now - windowLength)));
  RecentFilter(s, k);
  RecentFilter(after, k);
  ProofLib.FilterOfFilterShorter(p0, fk, s.events);
  if after.lastAdmitted {
    ProofLib.FilterAppend(fk, pruned, RateEvent(key, s.now));
    if k == key {
      ProofLib.FilterImpLength(fk, (e: RateEvent) => (e.key == key), pruned);
    }
  }
  forall e | e in after.events && !(e.key == key && after.lastAdmitted)
    ensures e in s.events
  {
    ProofLib.FilterMember(p0, s.events, e);
  }
}

lemma tick_ensures(s: RateLimits)
  ensures (inv(s) ==> canTick(s) ==> alwaysWindowNeverExceedsLimit(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> stepRefusalRecordsNothing(s, "tick", tick(s)))
{
  if inv(s) && canTick(s) {
    var after := tick(s);
    forall e | e in after.events
      ensures |recent(after, e.key)| <= maxRequests
    {
      RecentFilter(s, e.key);
      RecentFilter(after, e.key);
      ProofLib.FilterImpLength((x: RateEvent) => ((x.key == e.key) && (x.at > (after.now - windowLength))), (x: RateEvent) => ((x.key == e.key) && (x.at > (s.now - windowLength))), s.events);
    }
  }
}

lemma attempt_ensures(s: RateLimits, key: string)
  ensures (inv(s) ==> canAttempt(s, key) ==> alwaysWindowNeverExceedsLimit(attempt(s, key)))
  ensures (inv(s) ==> canAttempt(s, key) ==> stepRefusalRecordsNothing(s, "attempt", attempt(s, key)))
{
  if inv(s) && canAttempt(s, key) {
    var after := attempt(s, key);
    forall e | e in after.events
      ensures |recent(after, e.key)| <= maxRequests
    {
      AttemptRecent(s, key, e.key);
    }
  }
}
