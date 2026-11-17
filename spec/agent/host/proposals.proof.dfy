lemma validateClaim_ensures(p: Proposals)
  ensures (inv(p) ==> canValidateClaim(p) ==> alwaysAtMostOneGrant(validateClaim(p)))
  ensures (inv(p) ==> canValidateClaim(p) ==> stepGrantNeedsValidProposal(p, validateClaim(p)))
{
  if inv(p) && canValidateClaim(p) {
    ProofLib.FilterCons((set_x: int) => !((set_x in p.granted)), [p.claimedBy]);
    ProofLib.FilterNil((set_x: int) => !((set_x in p.granted)), [p.claimedBy][1..]);
  }
}
