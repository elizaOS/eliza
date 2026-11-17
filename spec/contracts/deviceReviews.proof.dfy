lemma BusyIntervalsOfOne(windowStart: int, windowEnd: int, e: AvailabilityEvent)
  ensures busyIntervals(windowStart, windowEnd, [e]) == (if (!(occupiesWindow(windowStart, windowEnd, e)) || e.availability.FreeTime?) then [] else [BusyInterval((if (e.startsAt > windowStart) then e.startsAt else windowStart), (if (e.endsAt < windowEnd) then e.endsAt else windowEnd), e.availability.TentativeTime?)])
{
  assert [e] == [] + [e];
  ProofLib.FoldLeftAppend((acc: seq<BusyInterval>, e: AvailabilityEvent) => (if (!(occupiesWindow(windowStart, windowEnd, e)) || e.availability.FreeTime?) then acc else (acc + [BusyInterval((if (e.startsAt > windowStart) then e.startsAt else windowStart), (if (e.endsAt < windowEnd) then e.endsAt else windowEnd), e.availability.TentativeTime?)])), [], [], e);
}

lemma lawBusyIntervalsStayInsideTheWindow_ensures(windowStart: int, windowEnd: int, e: AvailabilityEvent)
  ensures (lawBusyIntervalsStayInsideTheWindow(windowStart, windowEnd, e) == true)
{
  BusyIntervalsOfOne(windowStart, windowEnd, e);
  var bs := busyIntervals(windowStart, windowEnd, [e]);
  if |bs| == 1 {
    assert bs == [] + [bs[0]];
    ProofLib.FoldLeftAppend((ok: bool, b: BusyInterval) => (((ok && (b.busyFrom >= windowStart)) && (b.busyUntil <= windowEnd)) && (b.busyFrom < b.busyUntil)), true, [], bs[0]);
  }
}

lemma lawTentativeEventsAreBusyAndFlagged_ensures(windowStart: int, windowEnd: int, e: AvailabilityEvent)
  ensures (lawTentativeEventsAreBusyAndFlagged(windowStart, windowEnd, e) == true)
{
  BusyIntervalsOfOne(windowStart, windowEnd, e);
}

lemma lawFreeEventsNeverMakeTheOwnerBusy_ensures(windowStart: int, windowEnd: int, e: AvailabilityEvent)
  ensures (lawFreeEventsNeverMakeTheOwnerBusy(windowStart, windowEnd, e) == true)
{
  BusyIntervalsOfOne(windowStart, windowEnd, e);
}
