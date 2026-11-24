// The base and workflow operations' need requires nothing, offers the first listed capability, and offers no Clock
// handoff.
lemma OpsAnyButClock()
  ensures anyButClock.required == []
  ensures agent__deviceActions__capabilities_Capability.CalendarLocalEventV1 in anyButClock.oneOf
  ensures forall c :: c in anyButClock.oneOf ==> !c.ClockHandoffV1? && !c.ClockHandoffV2?
{
  var r := anyButClock.oneOf;
  forall c | c in r
    ensures !c.ClockHandoffV1? && !c.ClockHandoffV2?
  {
    var i :| 0 <= i < |r| && r[i] == c;
  }
  reveal Std.Collections.Seq.Filter();
  assert r[0] == agent__deviceActions__capabilities_Capability.CalendarLocalEventV1;
}

// Only the Clock handoff is in the Clock family.
lemma OpsClockFamily(t: OperationType)
  ensures family(t).ClockFamily? ==> t.ClockHandoff?
{
}

// Outside the Clock family a need's first required capability is not the Clock handoff, or it requires nothing and
// offers some alternatives, none of them the Clock handoff.
lemma OpsFamilyNeed(f: Family, t: OperationType, versionTwo: bool)
  requires !f.ClockFamily?
  ensures var n := familyNeed(f, t, versionTwo);
    (|n.required| > 0 && !n.required[0].ClockHandoffV1? && !n.required[0].ClockHandoffV2?) ||
    (|n.required| == 0 && |n.oneOf| > 0 && forall c :: c in n.oneOf ==> !c.ClockHandoffV1? && !c.ClockHandoffV2?)
{
  match f {
    case WorkflowFamily => OpsAnyButClock();
    case BaseFamily => OpsAnyButClock();
    case _ =>
  }
}
