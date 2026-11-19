lemma HeadingSitesFilter(recorded: RuleRef, knownRules: seq<RuleRef>)
  ensures headingSites(recorded, knownRules) == ProofLib.Filter((r: RuleRef) => (r.ownerHeading == recorded.ownerHeading), knownRules)
{
}

lemma lawAMissingHeadingNeedsASuccessor_ensures(recorded: RuleRef, knownRules: seq<RuleRef>, successors: seq<Successor>)
  ensures (lawAMissingHeadingNeedsASuccessor(recorded, knownRules, successors) == true)
{
  HeadingSitesFilter(recorded, knownRules);
  ProofLib.FilterMember((r: RuleRef) => (r.ownerHeading == recorded.ownerHeading), knownRules, recorded);
}
