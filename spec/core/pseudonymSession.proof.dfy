lemma PseudonymEntryAt(s: Pseudonyms,row: PseudonymEntry)
  requires alwaysMapsAreBijective(s) && row in s.entries
  ensures |ProofLib.Filter((entry: PseudonymEntry) => entry.value == row.value,s.entries)| == 1
  ensures ProofLib.Filter((entry: PseudonymEntry) => entry.value == row.value,s.entries)[0] == row
  ensures |ProofLib.Filter((entry: PseudonymEntry) => entry.surrogate == row.surrogate,s.entries)| == 1
  ensures ProofLib.Filter((entry: PseudonymEntry) => entry.surrogate == row.surrogate,s.entries)[0] == row
{
  ProofLib.FilterMember((entry: PseudonymEntry) => entry.value == row.value,s.entries,row);
  ProofLib.FilterMember((entry: PseudonymEntry) => entry.surrogate == row.surrogate,s.entries,row);
}

lemma PseudonymAppend(s: Pseudonyms,t: Pseudonyms,row: PseudonymEntry)
  requires alwaysMapsAreBijective(s) && t.entries == s.entries + [row]
  requires forall oldRow :: oldRow in s.entries ==> oldRow.value != row.value && oldRow.surrogate != row.surrogate
  ensures alwaysMapsAreBijective(t)
{
  forall e | e in t.entries
    ensures |ProofLib.Filter((other: PseudonymEntry) => other.value == e.value,t.entries)| == 1 &&
      |ProofLib.Filter((other: PseudonymEntry) => other.surrogate == e.surrogate,t.entries)| == 1
  {
    if e == row {
      ProofLib.FilterOne((other: PseudonymEntry) => other.value == e.value,t.entries,|s.entries|);
      ProofLib.FilterOne((other: PseudonymEntry) => other.surrogate == e.surrogate,t.entries,|s.entries|);
    } else {
      assert e in s.entries;
      ProofLib.FilterAppend((other: PseudonymEntry) => other.value == e.value,s.entries,row);
      ProofLib.FilterAppend((other: PseudonymEntry) => other.surrogate == e.surrogate,s.entries,row);
    }
  }
}

lemma PseudonymRemintSafe(s: Pseudonyms,t: Pseudonyms,value: string,surrogate: string)
  requires alwaysMapsAreBijective(s) && remintEligible(s,value,surrogate)
  requires t == remintValue(value,surrogate,s)
  ensures alwaysMapsAreBijective(t)
{
  forall row | row in t.entries
    ensures |ProofLib.Filter((other: PseudonymEntry) => other.value == row.value,t.entries)| == 1 &&
      |ProofLib.Filter((other: PseudonymEntry) => other.surrogate == row.surrogate,t.entries)| == 1
  {
    var i :| 0 <= i < |t.entries| && t.entries[i] == row;
    var p := s.entries[i];
    assert p in s.entries;
    ProofLib.FilterLengthPointwise((other: PseudonymEntry) => other.value == p.value,(other: PseudonymEntry) => other.value == row.value,s.entries,t.entries);
    forall j | 0 <= j < |s.entries|
      ensures (s.entries[j].surrogate == p.surrogate) == (t.entries[j].surrogate == row.surrogate)
    {
      var other := s.entries[j];
      assert other in s.entries;
      var updated := t.entries[j];
      assert updated == (if other.value == value then other.(surrogate := surrogate) else other);
      assert row == (if p.value == value then p.(surrogate := surrogate) else p);
      assert other.surrogate != surrogate && p.surrogate != surrogate;
      if p.value == value && other.value != value && other.surrogate == p.surrogate {
        PseudonymEntryAt(s,other);
        PseudonymEntryAt(s,p);
        assert other == p;
      } else if p.value != value && other.value == value && other.surrogate == p.surrogate {
        PseudonymEntryAt(s,other);
        PseudonymEntryAt(s,p);
        assert other == p;
      } else if p.value == value && other.value == value {
        PseudonymEntryAt(s,other);
        PseudonymEntryAt(s,p);
        assert other == p;
      }
    }
    ProofLib.FilterLengthPointwise((other: PseudonymEntry) => other.surrogate == p.surrogate,(other: PseudonymEntry) => other.surrogate == row.surrogate,s.entries,t.entries);
  }
}

lemma PseudonymRetiredTokens(entries: seq<PseudonymEntry>, initialTokens: seq<string>, token: string)
  requires token in initialTokens || (exists entry :: entry in entries && entry.surrogate == token)
  ensures token in Std.Collections.Seq.FoldLeft((retired: seq<string>, entry: PseudonymEntry) => addRetiredSurrogate(retired,entry), initialTokens, entries)
  decreases |entries|
{
  reveal Std.Collections.Seq.FoldLeft();
  var append := (retired: seq<string>, entry: PseudonymEntry) => addRetiredSurrogate(retired,entry);
  var final := Std.Collections.Seq.FoldLeft(append,initialTokens,entries);
  if |entries| > 0 {
    var row := entries[0];
    var tail := entries[1..];
    var after := append(initialTokens,row);
    assert entries == [row] + tail;
    assert final == Std.Collections.Seq.FoldLeft(append,after,tail);
    ProofLib.FilterMember((set_x: string) => !(set_x in initialTokens),[row.surrogate],row.surrogate);
    assert row.surrogate in after;
    if token !in initialTokens && token != row.surrogate {
      var entry :| entry in entries && entry.surrogate == token;
      assert entry in tail;
    }
    PseudonymRetiredTokens(tail,after,token);
  }
}

lemma PseudonymExpansionDecreases(s: Pseudonyms, todo: seq<LearningAtom>, base: seq<LearningAtom>, rank: int)
  requires alwaysRestorationDependenciesAreAcyclic(s)
  requires forall atom, row :: atom in todo && row in s.entries && row.surrogate == atom.text ==> row.ordinal < rank
  requires forall atom, row :: atom in base && row in s.entries && row.surrogate == atom.text ==> row.ordinal < rank - 1
  ensures forall atom,row :: atom in Std.Collections.Seq.FoldLeft((result: seq<LearningAtom>, q: LearningAtom) => expandAtom(s,result,q),base,todo) && row in s.entries && row.surrogate == atom.text ==> row.ordinal < rank - 1
  decreases |todo|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |todo| > 0 {
    var head := todo[0];
    var tail := todo[1..];
    var nextAtoms := expandAtom(s,base,head);
    if exists row :: row in s.entries && row.surrogate == head.text {
      var chosen := ProofLib.Filter((entry: PseudonymEntry) => entry.surrogate == head.text,s.entries);
      var known :| known in s.entries && known.surrogate == head.text;
      ProofLib.FilterMember((entry: PseudonymEntry) => entry.surrogate == head.text,s.entries,known);
      assert |chosen| > 0;
      ProofLib.FilterMember((entry: PseudonymEntry) => entry.surrogate == head.text,s.entries,chosen[0]);
      assert chosen[0] in s.entries && chosen[0].ordinal < rank;
      assert nextAtoms == base + chosen[0].valueAtoms;
      forall atom,row | atom in nextAtoms && row in s.entries && row.surrogate == atom.text
        ensures row.ordinal < rank - 1
      {
        if atom !in base {
          assert atom in chosen[0].valueAtoms;
          assert row.ordinal < chosen[0].ordinal;
        }
      }
    } else {
      assert nextAtoms == base + [head];
    }
    PseudonymExpansionDecreases(s,tail,nextAtoms,rank);
  }
}

lemma PseudonymRestoreBound(s: Pseudonyms, passes: seq<PseudonymEntry>, atoms: seq<LearningAtom>, rank: int)
  requires alwaysRestorationDependenciesAreAcyclic(s)
  requires forall atom,row :: atom in atoms && row in s.entries && row.surrogate == atom.text ==> row.ordinal < rank
  ensures forall atom,row :: atom in Std.Collections.Seq.FoldLeft((seen: seq<LearningAtom>, pass: PseudonymEntry) => restorePass(s,seen),atoms,passes) && row in s.entries && row.surrogate == atom.text ==> row.ordinal < rank - |passes|
  decreases |passes|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |passes| > 0 {
    var after := restorePass(s,atoms);
    PseudonymExpansionDecreases(s,atoms,[],rank);
    PseudonymRestoreBound(s,passes[1..],after,rank-1);
  }
}

lemma assignPseudonym_ensures(s: Pseudonyms, value: string, surrogate: string, kind: string)
  ensures (inv(s) ==> canAssignPseudonym(s, value, surrogate, kind) ==> alwaysRestorationDependenciesAreAcyclic(assignPseudonym(s, value, surrogate, kind)))
  ensures (inv(s) ==> canAssignPseudonym(s, value, surrogate, kind) ==> alwaysMappingVersionsAreValid(assignPseudonym(s, value, surrogate, kind)))
  ensures (inv(s) ==> canAssignPseudonym(s, value, surrogate, kind) ==> alwaysMapsAreBijective(assignPseudonym(s, value, surrogate, kind)))
  ensures (inv(s) ==> canAssignPseudonym(s, value, surrogate, kind) ==> alwaysCleanReplacersAreCurrent(assignPseudonym(s, value, surrogate, kind)))
{
  if inv(s) && canAssignPseudonym(s,value,surrogate,kind) {
    var t := assignPseudonym(s,value,surrogate,kind);
    var row := t.entries[|s.entries|];
    PseudonymAppend(s,t,row);
    var variants := ProofLib.Filter((span: LearningSpan) => span.value == value,s.knownSpans);
    if |variants| > 0 {
      ProofLib.FilterMember((span: LearningSpan) => span.value == value,s.knownSpans,variants[0]);
      assert variants[0] in s.knownSpans;
    }
    forall changed | changed in t.entries
      ensures changed.ordinal >= 0 && changed.ordinal < |t.entries| &&
        (forall atom, dependency :: atom in changed.valueAtoms && dependency in t.entries && dependency.surrogate == atom.text ==> dependency.ordinal < changed.ordinal)
    {
      if changed == row {
        assert changed.ordinal == |s.entries|;
        assert forall atom :: atom in changed.valueAtoms ==> atom.text != row.surrogate;
      } else {
        assert changed in s.entries;
        assert forall atom :: atom in changed.valueAtoms ==> atom.text != row.surrogate;
      }
    }
  }
}

lemma lawRemintPreservesBijection_ensures(s: Pseudonyms, value: string, surrogate: string)
  ensures (lawRemintPreservesBijection(s, value, surrogate) == true)
{
  if alwaysMapsAreBijective(s) && remintEligible(s,value,surrogate) {
    PseudonymRemintSafe(s,remintValue(value,surrogate,s),value,surrogate);
  }
}

lemma lawRemintRetainsOldToken_ensures(s: Pseudonyms, value: string, surrogate: string)
  ensures (lawRemintRetainsOldToken(s, value, surrogate) == true)
{
  if remintEligible(s,value,surrogate) {
    var selected := ProofLib.Filter((entry: PseudonymEntry) => entry.value == value,s.entries);
    forall row | row in s.entries && row.value == value
      ensures row.surrogate in remintValue(value,surrogate,s).retired
    {
      ProofLib.FilterMember((entry: PseudonymEntry) => entry.value == value,s.entries,row);
      PseudonymRetiredTokens(selected,s.retired,row.surrogate);
      assert remintValue(value,surrogate,s).retired == retiredAfterRemint(s,value);
      assert retiredAfterRemint(s,value) == Std.Collections.Seq.FoldLeft((retired: seq<string>, entry: PseudonymEntry) => addRetiredSurrogate(retired,entry),s.retired,selected);
    }
  }
}

lemma lawSurrogateOnlySpansAreSkipped_ensures(s: Pseudonyms, spans: seq<LearningSpan>, tokens: seq<string>)
  ensures (lawSurrogateOnlySpansAreSkipped(s, spans, tokens) == true)
{
  if forall span :: span in spans ==> onlySurrogates(s,span) {
    var accepted := ProofLib.Filter((span: LearningSpan) => !onlySurrogates(s,span),spans);
    ProofLib.FilterNone((span: LearningSpan) => !onlySurrogates(s,span),spans);
    assert |accepted| == 0;
    reveal Std.Collections.Seq.FoldLeft();
    assert learn(s,spans,tokens).knownValues == s.knownValues;
  }
}

lemma lawEntryRoundTrips_ensures(s: Pseudonyms, value: string)
  ensures (lawEntryRoundTrips(s, value) == true)
{
  if alwaysMapsAreBijective(s) && (exists row :: row in s.entries && row.value == value) {
    var r :| r in s.entries && r.value == value;
    PseudonymEntryAt(s,r);
  }
}

lemma lawRestorationReachesRealText_ensures(s: Pseudonyms, atoms: seq<LearningAtom>)
  ensures (lawRestorationReachesRealText(s, atoms) == true)
{
  if alwaysRestorationDependenciesAreAcyclic(s) {
    PseudonymRestoreBound(s,s.entries,atoms,|s.entries|);
  }
}
