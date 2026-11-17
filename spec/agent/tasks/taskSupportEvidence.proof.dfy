lemma SupportOrderView(recordedRoles: seq<string>)
  ensures orderedSupportRoles(recordedRoles) == ProofLib.Filter((role: string) => (role in recordedRoles), ["caregiver", "engineer", "other", "researcher"])
{
}

lemma DistinctSupportRolesView(recordedRoles: seq<string>)
  ensures distinctSupportRoles(recordedRoles) == !((exists role :: role in recordedRoles && !((|ProofLib.Filter((other: string) => (other == role), recordedRoles)| == 1))))
{
}

lemma OrderedRolesHaveVocabulary(recordedRoles: seq<string>)
  ensures forall role :: role in orderedSupportRoles(recordedRoles) ==> supportRole(role)
{
  SupportOrderView(recordedRoles);
  forall role | role in orderedSupportRoles(recordedRoles) ensures supportRole(role) {
    ProofLib.FilterMember((role: string) => (role in recordedRoles), ["caregiver", "engineer", "other", "researcher"], role);
  }
}

lemma lawOrderedSupportRolesAreIdempotent_ensures(recordedRoles: seq<string>)
  ensures (lawOrderedSupportRolesAreIdempotent(recordedRoles) == true)
{
  SupportOrderView(recordedRoles);
  SupportOrderView(orderedSupportRoles(recordedRoles));
  var vocabulary := ["caregiver", "engineer", "other", "researcher"];
  forall i | 0 <= i < |vocabulary|
    ensures (vocabulary[i] in orderedSupportRoles(recordedRoles)) == (vocabulary[i] in recordedRoles)
  {
    ProofLib.FilterMember((role: string) => (role in recordedRoles), vocabulary, vocabulary[i]);
  }
  ProofLib.FilterSamePredicate((role: string) => (role in orderedSupportRoles(recordedRoles)), (role: string) => (role in recordedRoles), vocabulary);
}

lemma lawOrderedSupportRolesAreUnique_ensures(recordedRoles: seq<string>)
  ensures (lawOrderedSupportRolesAreUnique(recordedRoles) == true)
{
  SupportOrderView(recordedRoles);
  var vocabulary := ["caregiver", "engineer", "other", "researcher"];
  ProofLib.FilterKeepsDistinctBy((role: string) => (role in recordedRoles), vocabulary, (role: string) => role);
  var ordered := orderedSupportRoles(recordedRoles);
  assert ProofLib.Distinct(ordered) by {
    forall i, j | 0 <= i < j < |ordered| ensures ordered[i] != ordered[j] {
    }
  }
  DistinctSupportRolesView(ordered);
  forall role | role in ordered
    ensures |ProofLib.Filter((other: string) => (other == role), ordered)| == 1
  {
    ProofLib.FilterDistinctCountOne((other: string) => (other == role), ordered, role);
  }
}

lemma lawOrderedSupportRolesKeepKnownMembership_ensures(recordedRoles: seq<string>, role: string)
  ensures (lawOrderedSupportRolesKeepKnownMembership(recordedRoles, role) == true)
{
  SupportOrderView(recordedRoles);
  ProofLib.FilterMember((role: string) => (role in recordedRoles), ["caregiver", "engineer", "other", "researcher"], role);
}

lemma lawSummaryRolesAreCanonical_ensures(reports: seq<ReportedSupport>)
  ensures (lawSummaryRolesAreCanonical(reports) == true)
{
  var recorded := Std.Collections.Seq.FoldLeft(addSupport, emptySummary, reports);
  lawOrderedSupportRolesAreIdempotent_ensures(recorded.humanRoles);
  lawOrderedSupportRolesAreIdempotent_ensures(recorded.requestedRoles);
  lawOrderedSupportRolesAreIdempotent_ensures(recorded.setupRoles);
  OrderedRolesHaveVocabulary(recorded.humanRoles);
  OrderedRolesHaveVocabulary(recorded.requestedRoles);
  OrderedRolesHaveVocabulary(recorded.setupRoles);
}

lemma lawSummaryRolesAreUnique_ensures(reports: seq<ReportedSupport>)
  ensures (lawSummaryRolesAreUnique(reports) == true)
{
  var recorded := Std.Collections.Seq.FoldLeft(addSupport, emptySummary, reports);
  lawOrderedSupportRolesAreUnique_ensures(recorded.humanRoles);
  lawOrderedSupportRolesAreUnique_ensures(recorded.requestedRoles);
  lawOrderedSupportRolesAreUnique_ensures(recorded.setupRoles);
}

lemma lawSummaryKeepsKnownRoleMembership_ensures(reports: seq<ReportedSupport>, role: string)
  ensures (lawSummaryKeepsKnownRoleMembership(reports, role) == true)
{
  var recorded := Std.Collections.Seq.FoldLeft(addSupport, emptySummary, reports);
  lawOrderedSupportRolesKeepKnownMembership_ensures(recorded.humanRoles, role);
  lawOrderedSupportRolesKeepKnownMembership_ensures(recorded.requestedRoles, role);
  lawOrderedSupportRolesKeepKnownMembership_ensures(recorded.setupRoles, role);
}
