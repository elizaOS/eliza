// spec/wallet/requests.md, "Only the owner's decision takes a request off the desk"
lemma DecidedRequestsAreTheOthers(d: Desk, id: int, ownerDecided: bool)
  ensures decideRequest(d, id, ownerDecided).waiting == ProofLib.Filter((request: TransferRequest) => (request.id != id), d.waiting)
{
}

lemma decideRequest_ensures(d: Desk, id: int, ownerDecided: bool)
  ensures (inv(d) ==> canDecideRequest(d, id, ownerDecided) ==> alwaysEveryWaitingRequestWasIssued(decideRequest(d, id, ownerDecided)))
  ensures (inv(d) ==> canDecideRequest(d, id, ownerDecided) ==> alwaysTheDeskHasRoomForEight(decideRequest(d, id, ownerDecided)))
  ensures (inv(d) ==> canDecideRequest(d, id, ownerDecided) ==> alwaysWaitingTermsAreComplete(decideRequest(d, id, ownerDecided)))
  ensures (inv(d) ==> canDecideRequest(d, id, ownerDecided) ==> stepAWaitingRequestKeepsItsTerms(d, decideRequest(d, id, ownerDecided)))
  ensures (inv(d) ==> canDecideRequest(d, id, ownerDecided) ==> stepOnlyADecisionRemovesARequest(d, "decideRequest", decideRequest(d, id, ownerDecided)))
  ensures (inv(d) ==> canDecideRequest(d, id, ownerDecided) ==> stepNumbersAreNeverReused(d, decideRequest(d, id, ownerDecided)))
{
  if inv(d) && canDecideRequest(d, id, ownerDecided) {
    var after := decideRequest(d, id, ownerDecided);
    DecidedRequestsAreTheOthers(d, id, ownerDecided);
    forall kept | kept in after.waiting ensures kept in d.waiting && kept.id != id {
      ProofLib.FilterMember((request: TransferRequest) => (request.id != id), d.waiting, kept);
    }
    forall other | other in d.waiting && other.id != id ensures other in after.waiting {
      ProofLib.FilterMember((request: TransferRequest) => (request.id != id), d.waiting, other);
    }
  }
}
