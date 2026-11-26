lemma lawOnlyAnAdmittedPinnedSourceComposes_ensures(c: CompositionCall)
  ensures (lawOnlyAnAdmittedPinnedSourceComposes(c) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawProductionNeedsAReleaseLock_ensures(c: CompositionCall)
  ensures (lawProductionNeedsAReleaseLock(c) == true)
{
  reveal Std.Collections.Seq.Filter();
  if compositionAdmitted(c) && c.purpose.Production? && os__image__sourceLock_alwaysProductionNeedsAReleaseLock(c.source) {
    var a := os__image__sourceLock_Admission(c.brandToken, os__image__sourceLock_ProductName(c.brandToken, lockTarget(c.descriptor)), c.purpose);
    assert a in c.source.admitted;
  }
}

lemma lawPixelLauncherIsTheStagedOneOffSystem_ensures(c: CompositionCall)
  ensures (lawPixelLauncherIsTheStagedOneOffSystem(c) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawNothingIsOverwritten_ensures(c: CompositionCall)
  ensures (lawNothingIsOverwritten(c) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawComposedProductKeepsPlatformSecurity_ensures(c: CompositionCall)
  ensures (lawComposedProductKeepsPlatformSecurity(c) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawStagedBootAnimationIsThePinnedBytes_ensures(c: CompositionCall)
  ensures (lawStagedBootAnimationIsThePinnedBytes(c) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawPlaceholderNeverReachesProduction_ensures(c: CompositionCall)
  ensures (lawPlaceholderNeverReachesProduction(c) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawEnabledOrChangedUpdaterIsNeverStaged_ensures(c: CompositionCall)
  ensures (lawEnabledOrChangedUpdaterIsNeverStaged(c) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawEnrollmentTrustsOnlyTheChannel_ensures(e: Enrollment, d: ProductDescriptor, channelCertificate: os__image__apk_Digest, certificateRead: os__image__apk_Digest)
  ensures (lawEnrollmentTrustsOnlyTheChannel(e, d, channelCertificate, certificateRead) == true)
{
  reveal Std.Collections.Seq.Filter();
}
