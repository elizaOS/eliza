lemma lawProductionTakesOnlyReviewedReleaseBuilds_ensures(call: StagingCall)
  ensures (lawProductionTakesOnlyReviewedReleaseBuilds(call) == true)
{
  if stagingAdmission(call).StagingAdmitted? && call.stagingMode.StageProduction? {
    forall c | c in call.companions
      ensures c.apk.buildType.ReleaseBuild?
    {
      var x :| x in call.descriptor.companions && x.moduleName == c.moduleName;
      assert companionAdmitted(call.descriptor, call.companions, call.stagingMode, x);
      var matches := ProofLib.Filter((y: SuppliedCompanion) => (y.moduleName == x.moduleName), call.companions);
      ProofLib.FilterMember((y: SuppliedCompanion) => (y.moduleName == x.moduleName), call.companions, c);
      assert c in matches;
      assert c == matches[0];
    }
  }
}
