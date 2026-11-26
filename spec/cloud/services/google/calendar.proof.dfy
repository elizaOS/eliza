lemma CapabilitiesFilter(scopes: seq<cloud__services__google__connection_GoogleScope>)
  ensures cloud__services__google__connection_capabilitiesOf(scopes) == ProofLib.Filter((k: cloud__services__google__connection_GoogleCapability) => cloud__services__google__connection_grantsCapability(scopes, k), cloud__services__google__connection_allCapabilities)
{
}

lemma lawAWritableCalendarIsReadable_ensures(scopes: seq<cloud__services__google__connection_GoogleScope>, role: CalendarRole)
  ensures (lawAWritableCalendarIsReadable(scopes, role) == true)
{
  if rowAccess(scopes, role).write {
    var p := (k: cloud__services__google__connection_GoogleCapability) => cloud__services__google__connection_grantsCapability(scopes, k);
    CapabilitiesFilter(scopes);
    ProofLib.FilterMember(p, cloud__services__google__connection_allCapabilities, cloud__services__google__connection_GoogleCapability.CalendarWrite);
    ProofLib.FilterMember(p, cloud__services__google__connection_allCapabilities, cloud__services__google__connection_GoogleCapability.CalendarRead);
    assert cloud__services__google__connection_GoogleCapability.CalendarRead in cloud__services__google__connection_allCapabilities;
  }
}
