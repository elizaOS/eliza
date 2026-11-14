lemma ContextSelectionShape(s: Context, keep: seq<string>, expectedRevision: int, complete: bool, shapeValid: bool)
  ensures selectHistory(s, keep, expectedRevision, complete, shapeValid).originals == s.originals
  ensures selectHistory(s, keep, expectedRevision, complete, shapeValid).selected == (selectionValid(s, keep, expectedRevision, complete, shapeValid) && |ProofLib.Filter((source: Source) => (source.id in keep), s.originals)| < |s.originals|)
  ensures selectHistory(s, keep, expectedRevision, complete, shapeValid).visible == (if selectHistory(s, keep, expectedRevision, complete, shapeValid).selected then ProofLib.Filter((source: Source) => (source.id in keep), s.originals) else s.originals)
{}

lemma ContextSelectedRule(s: Context)
  ensures alwaysSelectedHistoryKeepsOrder(s) == (!s.selected || (|s.visible| < |s.originals| && (forall source :: source in s.originals ==> |ProofLib.Filter((other: Source) => (other.id == source.id), s.originals)| == 1) && s.visible == ProofLib.Filter((source: Source) => (exists retained :: retained in s.visible && (retained.id == source.id)), s.originals)))
{}

lemma ContextValidSelection(s: Context, keep: seq<string>, expectedRevision: int, complete: bool, shapeValid: bool)
  ensures selectionValid(s, keep, expectedRevision, complete, shapeValid) ==> (forall source :: source in s.originals ==> |ProofLib.Filter((other: Source) => (other.id == source.id), s.originals)| == 1)
{}

lemma ContextRefilter(originals: seq<Source>, kept: seq<Source>, keep: seq<string>)
  requires kept == ProofLib.Filter((source: Source) => (source.id in keep), originals)
  ensures kept == ProofLib.Filter((source: Source) => (exists retained :: retained in kept && (retained.id == source.id)), originals)
{
  forall i | 0 <= i < |originals|
    ensures (originals[i].id in keep) == (exists retained :: retained in kept && retained.id == originals[i].id)
  {
    if originals[i].id in keep {
      ProofLib.FilterMember((source: Source) => (source.id in keep), originals, originals[i]);
      assert originals[i] in kept;
    } else if exists retained :: retained in kept && retained.id == originals[i].id {
      var candidate :| candidate in kept && candidate.id == originals[i].id;
      ProofLib.FilterMember((source: Source) => (source.id in keep), originals, candidate);
    }
  }
  ProofLib.FilterSamePredicate((source: Source) => (source.id in keep), (source: Source) => (exists retained :: retained in kept && (retained.id == source.id)), originals);
}

lemma ContextKeepAll(originals: seq<Source>, keep: seq<string>)
  requires forall source :: source in originals ==> source.id in keep
  ensures ProofLib.Filter((source: Source) => (source.id in keep), originals) == originals
  decreases |originals|
{
  if |originals| == 0 {
    ProofLib.FilterNil((source: Source) => (source.id in keep), originals);
  } else {
    ProofLib.FilterCons((source: Source) => (source.id in keep), originals);
    ContextKeepAll(originals[1..], keep);
    assert originals == [originals[0]] + originals[1..];
  }
}

lemma selectHistory_ensures(s: Context, keep: seq<string>, expectedRevision: int, complete: bool, shapeValid: bool)
  ensures (inv(s) ==> alwaysMandatoryEvidenceIsComplete(selectHistory(s, keep, expectedRevision, complete, shapeValid)))
  ensures (inv(s) ==> alwaysVisibleSourcesAreExactOriginals(selectHistory(s, keep, expectedRevision, complete, shapeValid)))
  ensures (inv(s) ==> alwaysFullModeContainsAllSources(selectHistory(s, keep, expectedRevision, complete, shapeValid)))
  ensures (inv(s) ==> alwaysSourceIdentityIsValid(selectHistory(s, keep, expectedRevision, complete, shapeValid)))
  ensures (inv(s) ==> alwaysSelectedHistoryKeepsOrder(selectHistory(s, keep, expectedRevision, complete, shapeValid)))
  ensures (inv(s) ==> alwaysRestorationIsExact(selectHistory(s, keep, expectedRevision, complete, shapeValid)))
  ensures (inv(s) ==> stepInvalidSelectionRetainsFullContext(s, "selectHistory", selectHistory(s, keep, expectedRevision, complete, shapeValid)))
{
  if inv(s) {
    var after := selectHistory(s, keep, expectedRevision, complete, shapeValid);
    ContextSelectionShape(s, keep, expectedRevision, complete, shapeValid);
    ContextSelectedRule(after);
    if after.selected {
      ContextValidSelection(s, keep, expectedRevision, complete, shapeValid);
      ContextRefilter(s.originals, after.visible, keep);
      forall source | source in after.visible ensures source in after.originals {
        ProofLib.FilterMember((source: Source) => (source.id in keep), s.originals, source);
      }
    }
  }
}

lemma lawKeepingEverySourceDoesNotApply_ensures(s: Context, keep: seq<string>, expectedRevision: int, complete: bool, shapeValid: bool)
  ensures (lawKeepingEverySourceDoesNotApply(s, keep, expectedRevision, complete, shapeValid) == true)
{
  if forall source :: source in s.originals ==> source.id in keep {
    ContextKeepAll(s.originals, keep);
    ContextSelectionShape(s, keep, expectedRevision, complete, shapeValid);
  }
}
