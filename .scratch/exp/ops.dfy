// A member of a filtered list is a member of the list the filter keeps.
lemma OpsFilterMember<T>(p: T -> bool, xs: seq<T>, x: T)
  ensures x in Std.Collections.Seq.Filter(p, xs) <==> x in xs && p(x)
  decreases |xs|
{
  reveal Std.Collections.Seq.Filter();
  if |xs| > 0 {
    OpsFilterMember(p, xs[1..], x);
    assert xs == [xs[0]] + xs[1..];
  }
}

// The base and workflow operations' need requires nothing, offers the first listed capability, and offers no Clock
// handoff.
lemma OpsAnyButClock()
  ensures anyButClock.required == []
  ensures agent__deviceActions__capabilities_Capability.CalendarLocalEventV1 in anyButClock.oneOf
  ensures forall c :: c in anyButClock.oneOf ==> !c.ClockHandoffV1? && !c.ClockHandoffV2?
{
  var all := agent__deviceActions__capabilities_allCapabilities;
  var p := (set_x: agent__deviceActions__capabilities_Capability) => !((set_x in [typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV1), typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV2)]));
  assert anyButClock.oneOf == Std.Collections.Seq.Filter(p, typed0_agent__deviceActions__operations(all));
  assert all[0] == agent__deviceActions__capabilities_Capability.CalendarLocalEventV1;
  forall c
    ensures c in anyButClock.oneOf <==> c in all && p(c)
  {
    OpsFilterMember(p, all, c);
  }
}
