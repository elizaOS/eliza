// A named capability is in the vocabulary, and the filter keeps what passes.
lemma lawEveryNamedCapabilityIsNegotiated_ensures(names: seq<string>, c: Capability)
  ensures (lawEveryNamedCapabilityIsNegotiated(names, c) == true)
{
  if !isRefused(negotiate(true, names)) && capabilityName(c) in names {
    lawTheVocabularyListsEveryCapability_ensures(c);
    var p := (x: Capability) => (capabilityName(x) in names);
    ProofLib.FilterMember(p, allCapabilities, c);
    assert c in namedCapabilities(names);
  }
}
