lemma lawAdmittedPlanMapsEveryRequiredKey_ensures(required: seq<string>, mapped: seq<string>)
  ensures (lawAdmittedPlanMapsEveryRequiredKey(required, mapped) == true)
{
  ProofLib.FilterNone((set_x: string) => !((set_x in mapped)), required);
}

lemma lawAdmittedDescriptorPinsAReleaseLock_ensures(r: ReleaseDescriptor)
  ensures (lawAdmittedDescriptorPinsAReleaseLock(r) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawAdmittedChannelTrustsOnlyTheProductsKeys_ensures(ch: ReleaseChannel, product: os__image__product_ProductDescriptor, r: ReleaseDescriptor)
  ensures (lawAdmittedChannelTrustsOnlyTheProductsKeys(ch, product, r) == true)
{
  reveal Std.Collections.Seq.Filter();
}
