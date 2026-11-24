lemma lawAnAdmittedChangeIsOneTheCapabilitiesOffer_ensures(proposal: Proposal, authority: MailAuthority)
  ensures (lawAnAdmittedChangeIsOneTheCapabilitiesOffer(proposal, authority) == true)
{
  if authorityAllows(proposal, authority) {
    var kind := kindOfProposal(proposal);
    var offered := (k: cloud__services__google__mailRead_MailOperationKind) => (cloud__services__google__mailRead_kindNeeds(k) in cloud__services__google__connection_capabilitiesOf(authority.scopes));
    assert offered(kind);
    assert kind in cloud__services__google__mailRead_allOperationKinds;
    ProofLib.FilterMember(offered, cloud__services__google__mailRead_allOperationKinds, kind);
    assert cloud__services__google__mailRead_offeredKinds(authority.scopes) == ProofLib.Filter(offered, cloud__services__google__mailRead_allOperationKinds);
  }
}
