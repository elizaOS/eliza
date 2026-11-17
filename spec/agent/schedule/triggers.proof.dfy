// The occurrence a cron trigger moves on to lies after now, so it is neither a fired occurrence nor the one just fired.
lemma fire_ensures(t: Trigger, nextInstant: int)
  ensures (inv(t) ==> canFire(t, nextInstant) ==> alwaysARunUsesTheSavedTrigger(fire(t, nextInstant)))
  ensures (inv(t) ==> canFire(t, nextInstant) ==> alwaysFiredOccurrencesAreNotAhead(fire(t, nextInstant)))
  ensures (inv(t) ==> canFire(t, nextInstant) ==> alwaysTheNextOccurrenceHasNotFired(fire(t, nextInstant)))
  ensures (inv(t) ==> canFire(t, nextInstant) ==> alwaysHistoryIsBounded(fire(t, nextInstant)))
  ensures (inv(t) ==> canFire(t, nextInstant) ==> stepAFiringRunsOrIsMissed(t, "fire", fire(t, nextInstant)))
  ensures (inv(t) ==> canFire(t, nextInstant) ==> stepAnEventIdRunsOnce(t, "fire", fire(t, nextInstant)))
{
  if inv(t) && canFire(t, nextInstant) {
    ProofLib.FilterMember((set_x: int) => !((set_x in t.firedAt)), [t.nextAt], nextInstant);
    ProofLib.FilterMember((set_x: int) => !((set_x in t.firedAt)), [t.nextAt], t.nextAt);
  }
}

// An unseen event id adds exactly one member to the seen set.
lemma receiveEvent_ensures(t: Trigger, eventId: string, name: string)
  ensures (inv(t) ==> canReceiveEvent(t, eventId, name) ==> alwaysARunUsesTheSavedTrigger(receiveEvent(t, eventId, name)))
  ensures (inv(t) ==> canReceiveEvent(t, eventId, name) ==> alwaysFiredOccurrencesAreNotAhead(receiveEvent(t, eventId, name)))
  ensures (inv(t) ==> canReceiveEvent(t, eventId, name) ==> alwaysTheNextOccurrenceHasNotFired(receiveEvent(t, eventId, name)))
  ensures (inv(t) ==> canReceiveEvent(t, eventId, name) ==> alwaysHistoryIsBounded(receiveEvent(t, eventId, name)))
  ensures (inv(t) ==> canReceiveEvent(t, eventId, name) ==> stepAFiringRunsOrIsMissed(t, "receiveEvent", receiveEvent(t, eventId, name)))
  ensures (inv(t) ==> canReceiveEvent(t, eventId, name) ==> stepAnEventIdRunsOnce(t, "receiveEvent", receiveEvent(t, eventId, name)))
{
  if inv(t) && canReceiveEvent(t, eventId, name) {
    ProofLib.FilterCons((set_x: string) => !((set_x in t.seenEvents)), [eventId]);
    ProofLib.FilterNil((set_x: string) => !((set_x in t.seenEvents)), [eventId][1..]);
  }
}
