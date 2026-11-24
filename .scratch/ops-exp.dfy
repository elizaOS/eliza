
lemma ExpA()
  ensures agent__deviceActions__capabilities_Capability.CalendarLocalEventV1 in anyButClock.oneOf
  ensures forall c :: c in anyButClock.oneOf ==> !c.ClockHandoffV1? && !c.ClockHandoffV2?
{
  var L: agent__deviceActions__capabilities_Capability -> bool :| anyButClock.oneOf == Std.Collections.Seq.Filter(L, typed0_agent__deviceActions__operations(agent__deviceActions__capabilities_allCapabilities)) && forall c :: L(c) == !(c in [typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV1), typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV2)]);
  forall c ensures c in anyButClock.oneOf <==> c in agent__deviceActions__capabilities_allCapabilities && L(c) {
    ProofLib.FilterMember(L, agent__deviceActions__capabilities_allCapabilities, c);
  }
}

lemma ExpB()
  ensures agent__deviceActions__capabilities_Capability.CalendarLocalEventV1 in anyButClock.oneOf
  ensures forall c :: c in anyButClock.oneOf ==> !c.ClockHandoffV1? && !c.ClockHandoffV2?
{
  var p := (set_x: agent__deviceActions__capabilities_Capability) => !((set_x in [typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV1), typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV2)]));
  assert anyButClock.oneOf == Std.Collections.Seq.Filter(p, typed0_agent__deviceActions__operations(agent__deviceActions__capabilities_allCapabilities));
  forall c ensures c in anyButClock.oneOf <==> c in agent__deviceActions__capabilities_allCapabilities && p(c) {
    ProofLib.FilterMember(p, agent__deviceActions__capabilities_allCapabilities, c);
  }
}

lemma ExpC()
  ensures exists L: agent__deviceActions__capabilities_Capability -> bool :: anyButClock.oneOf == Std.Collections.Seq.Filter(L, typed0_agent__deviceActions__operations(agent__deviceActions__capabilities_allCapabilities))
{
}
