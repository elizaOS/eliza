lemma GmailCapabilitiesFilter(scopes: seq<cloud__services__google__connection_GoogleScope>)
  ensures cloud__services__google__connection_capabilitiesOf(scopes) ==
    ProofLib.Filter((k: cloud__services__google__connection_GoogleCapability) => cloud__services__google__connection_grantsCapability(scopes, k), cloud__services__google__connection_allCapabilities)
{
}

lemma GmailCapabilityMembership(scopes: seq<cloud__services__google__connection_GoogleScope>, capability: cloud__services__google__connection_GoogleCapability)
  ensures capability in cloud__services__google__connection_capabilitiesOf(scopes) <==>
    cloud__services__google__connection_grantsCapability(scopes, capability)
{
  GmailCapabilitiesFilter(scopes);
  assert capability in cloud__services__google__connection_allCapabilities;
  ProofLib.FilterMember((k: cloud__services__google__connection_GoogleCapability) => cloud__services__google__connection_grantsCapability(scopes, k), cloud__services__google__connection_allCapabilities, capability);
}

lemma lawAReadNeedsTheCapabilityTheStatusReports_ensures(surface: MailSurface, scopes: seq<cloud__services__google__connection_GoogleScope>)
  ensures (lawAReadNeedsTheCapabilityTheStatusReports(surface, scopes) == true)
{
  if !surface.CapabilitiesSurface? && surfaceHeld(surface, scopes) {
    var granted :| granted in surfaceScopes(surface) && granted in scopes;
    var capability := if surface.DraftsSurface? || surface.DraftSurface?
      then cloud__services__google__connection_GoogleCapability.GmailDrafts
      else cloud__services__google__connection_GoogleCapability.GmailTriage;
    assert cloud__services__google__connection_grantsCapability(scopes, capability);
    GmailCapabilityMembership(scopes, capability);
  }
}

lemma GmailTriageReasonsFilter(signals: TriageSignals)
  ensures triageReasons(signals) ==
    ProofLib.Filter((r: TriageReason) => reasonApplies(signals, r), [typed1_cloud__services__google__mailRead(TriageReason.TriageUnread), typed1_cloud__services__google__mailRead(TriageReason.TriageImportantLabel), typed1_cloud__services__google__mailRead(TriageReason.TriageAddressed), typed1_cloud__services__google__mailRead(TriageReason.TriageNeedsReply), typed1_cloud__services__google__mailRead(TriageReason.TriageAutomated), typed1_cloud__services__google__mailRead(TriageReason.TriageSentBySelf)])
{
}

lemma lawAScoreIsWithinItsRange_ensures(signals: TriageSignals)
  ensures (lawAScoreIsWithinItsRange(signals) == true)
{
  assert 0 <= triageScore(signals) <= 110;
  if triageReasons(signals) == [] {
    var reasons := [typed1_cloud__services__google__mailRead(TriageReason.TriageUnread), typed1_cloud__services__google__mailRead(TriageReason.TriageImportantLabel), typed1_cloud__services__google__mailRead(TriageReason.TriageAddressed), typed1_cloud__services__google__mailRead(TriageReason.TriageNeedsReply), typed1_cloud__services__google__mailRead(TriageReason.TriageAutomated), typed1_cloud__services__google__mailRead(TriageReason.TriageSentBySelf)];
    var applies := (r: TriageReason) => reasonApplies(signals, r);
    GmailTriageReasonsFilter(signals);
    ProofLib.FilterNone(applies, reasons);
    assert !applies(reasons[0]) && !applies(reasons[1]) && !applies(reasons[2]);
    assert triageScore(signals) == 0;
  }
}

lemma GmailOfferedKindsFilter(scopes: seq<cloud__services__google__connection_GoogleScope>)
  ensures offeredKinds(scopes) ==
    ProofLib.Filter((k: MailOperationKind) => (kindNeeds(k) in cloud__services__google__connection_capabilitiesOf(scopes)), allOperationKinds)
{
}

lemma GmailOfferedReadsFilter(scopes: seq<cloud__services__google__connection_GoogleScope>)
  ensures offeredReads(scopes) == ProofLib.Filter((s: MailSurface) => surfaceHeld(s, scopes), allSurfaces)
{
}

lemma GmailHeldSurfaceIsOffered(surface: MailSurface, scopes: seq<cloud__services__google__connection_GoogleScope>)
  requires surfaceHeld(surface, scopes)
  ensures surface in offeredReads(scopes)
{
  GmailOfferedReadsFilter(scopes);
  assert surface in allSurfaces;
  ProofLib.FilterMember((s: MailSurface) => surfaceHeld(s, scopes), allSurfaces, surface);
}

lemma lawEveryOfferedChangeComesWithTheReadItsReviewNeeds_ensures(kind: MailOperationKind, scopes: seq<cloud__services__google__connection_GoogleScope>)
  ensures (lawEveryOfferedChangeComesWithTheReadItsReviewNeeds(kind, scopes) == true)
{
  if kind in offeredKinds(scopes) && !kind.SendKind? {
    GmailOfferedKindsFilter(scopes);
    ProofLib.FilterMember((k: MailOperationKind) => (kindNeeds(k) in cloud__services__google__connection_capabilitiesOf(scopes)), allOperationKinds, kind);
    GmailCapabilityMembership(scopes, kindNeeds(kind));
    if isDraftKind(kind) {
      GmailHeldSurfaceIsOffered(MailSurface.DraftSurface, scopes);
    } else {
      GmailHeldSurfaceIsOffered(MailSurface.MessageSurface, scopes);
      GmailHeldSurfaceIsOffered(MailSurface.ThreadSurface, scopes);
    }
  }
}
