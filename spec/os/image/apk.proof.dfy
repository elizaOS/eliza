lemma lawObservedSignerWasReportedForTheApi_ensures(report: SignerReport, api: int)
  ensures (lawObservedSignerWasReportedForTheApi(report, api) == true)
{
  var f := ProofLib.Filter((r: RangedSignerRow) => rangeHolds(r, api), report.ranged);
  if |f| == 1 {
    ProofLib.FilterMember((r: RangedSignerRow) => rangeHolds(r, api), report.ranged, f[0]);
  }
}

lemma lawPlaceholderSignerNeverReleases_ensures(row: ApkRow, policy: ReleasePolicy)
  ensures (lawPlaceholderSignerNeverReleases(row, policy) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawCleanCloudSpeechReleaseIsQualifiedForThisApk_ensures(row: ApkRow, policy: ReleasePolicy)
  ensures (lawCleanCloudSpeechReleaseIsQualifiedForThisApk(row, policy) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawAdmittedUpdateKeepsAKnownSigner_ensures(installed: PackageVersion, candidate: PackageVersion)
  ensures (lawAdmittedUpdateKeepsAKnownSigner(installed, candidate) == true)
{
  reveal Std.Collections.Seq.Filter();
}
