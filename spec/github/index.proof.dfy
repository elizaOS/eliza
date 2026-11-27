lemma lawGitHubOmissionsWereRequested_ensures(requested: seq<string>, observed: seq<string>)
  ensures (lawGitHubOmissionsWereRequested(requested, observed) == true)
{
  var p := (name: string) => !((name in observed));
  forall name | name in githubMissingNames(requested, observed)
    ensures (name in requested) && !(name in observed)
  {
    ProofLib.FilterMember(p, requested, name);
  }
}
