lemma lawReconnectKeepsHeldAccess_ensures(request: GrantRequest, held: seq<GmailCapability>)
  ensures (lawReconnectKeepsHeldAccess(request, held) == true)
{
  var req := requestedCapabilities(request);
  var p := (set_x: GmailCapability) => !((set_x in req));
  forall x | x in held
    ensures x in consentCapabilities(request, held)
  {
    if !(x in req) {
      ProofLib.FilterMember(p, held, x);
    }
  }
}

lemma lawModifyIsOneConsent_ensures(held: seq<GmailCapability>)
  ensures (lawModifyIsOneConsent(held) == true)
{
  var p := (set_x: GmailCapability) => !((set_x in readCapabilities));
  forall x | x in modifyCapabilities
    ensures x in consentCapabilities(GrantRequest.AskModify, held)
  {
    if !(x in readCapabilities) {
      ProofLib.FilterMember(p, modifyCapabilities, x);
    }
  }
}
