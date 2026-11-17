lemma IncludesFilter(c: Config)
  ensures alwaysIncludesBoundedAndAcyclic(c) == ((|c.includes| <= includeDepth) && !((exists i :: i in c.includes && !((|ProofLib.Filter((j: int) => (j == i), c.includes)| == 1)))))
  ensures leaveInclude(c).includes == ProofLib.Filter((i: int) => (i != (if ((0 <= (|c.includes| - 1)) && ((|c.includes| - 1) < |c.includes|)) then c.includes[(|c.includes| - 1)] else 0)), c.includes)
{
}

lemma FilterNoLonger(p: int -> bool, xs: seq<int>)
  ensures |ProofLib.Filter(p, xs)| <= |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    FilterNoLonger(p, xs[1..]);
  }
}

lemma enterInclude_ensures(c: Config, include_: int)
  ensures (inv(c) ==> canEnterInclude(c, include_) ==> alwaysStagedDocumentIsNew(enterInclude(c, include_)))
  ensures (inv(c) ==> canEnterInclude(c, include_) ==> alwaysIncludesBoundedAndAcyclic(enterInclude(c, include_)))
  ensures (inv(c) ==> canEnterInclude(c, include_) ==> alwaysCachedScopeIsCurrent(enterInclude(c, include_)))
  ensures (inv(c) ==> canEnterInclude(c, include_) ==> stepCommitOnlyAfterSync(c, enterInclude(c, include_)))
  ensures (inv(c) ==> canEnterInclude(c, include_) ==> stepHostRunsOnlyCommittedDocument(c, enterInclude(c, include_)))
  ensures (inv(c) ==> canEnterInclude(c, include_) ==> stepFailedWriteKeepsDocument(c, "enterInclude", enterInclude(c, include_)))
{
  if inv(c) && canEnterInclude(c, include_) {
    var after := enterInclude(c, include_);
    IncludesFilter(c);
    IncludesFilter(after);
    forall i | i in after.includes
      ensures |ProofLib.Filter((j: int) => (j == i), after.includes)| == 1
    {
      ProofLib.FilterAppend((j: int) => (j == i), c.includes, include_);
      if i == include_ {
        ProofLib.FilterNone((j: int) => (j == i), c.includes);
      }
    }
  }
}

lemma leaveInclude_ensures(c: Config)
  ensures (inv(c) ==> canLeaveInclude(c) ==> alwaysStagedDocumentIsNew(leaveInclude(c)))
  ensures (inv(c) ==> canLeaveInclude(c) ==> alwaysIncludesBoundedAndAcyclic(leaveInclude(c)))
  ensures (inv(c) ==> canLeaveInclude(c) ==> alwaysCachedScopeIsCurrent(leaveInclude(c)))
  ensures (inv(c) ==> canLeaveInclude(c) ==> stepCommitOnlyAfterSync(c, leaveInclude(c)))
  ensures (inv(c) ==> canLeaveInclude(c) ==> stepHostRunsOnlyCommittedDocument(c, leaveInclude(c)))
  ensures (inv(c) ==> canLeaveInclude(c) ==> stepFailedWriteKeepsDocument(c, "leaveInclude", leaveInclude(c)))
{
  if inv(c) && canLeaveInclude(c) {
    var after := leaveInclude(c);
    IncludesFilter(c);
    IncludesFilter(after);
    FilterNoLonger((i: int) => (i != (if ((0 <= (|c.includes| - 1)) && ((|c.includes| - 1) < |c.includes|)) then c.includes[(|c.includes| - 1)] else 0)), c.includes);
    forall i | i in after.includes
      ensures |ProofLib.Filter((j: int) => (j == i), after.includes)| == 1
    {
      ProofLib.FilterMember((i: int) => (i != (if ((0 <= (|c.includes| - 1)) && ((|c.includes| - 1) < |c.includes|)) then c.includes[(|c.includes| - 1)] else 0)), c.includes, i);
      ProofLib.FilterOfFilterShorter((i: int) => (i != (if ((0 <= (|c.includes| - 1)) && ((|c.includes| - 1) < |c.includes|)) then c.includes[(|c.includes| - 1)] else 0)), (j: int) => (j == i), c.includes);
      ProofLib.FilterNone((j: int) => (j == i), after.includes);
    }
  }
}
