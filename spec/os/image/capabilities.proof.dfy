lemma AdvertisedIsFilter(staged: seq<string>, requested: seq<string>)
  ensures advertisedFeatures(staged, requested) == ProofLib.Filter((set_x: string) => (set_x in staged), requested)
{
}

lemma lawOverlayAdvertisesOnlyStagedPackages_ensures(staged: seq<string>, requested: seq<string>)
  ensures (lawOverlayAdvertisesOnlyStagedPackages(staged, requested) == true)
{
  AdvertisedIsFilter(staged, requested);
  forall x | x in advertisedFeatures(staged, requested)
    ensures x in staged && x in requested
  {
    ProofLib.FilterMember((set_x: string) => (set_x in staged), requested, x);
  }
}
