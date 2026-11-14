lemma SweepIdMembership(rows: seq<SourceRow>, base: seq<string>)
  ensures forall id :: (id in Std.Collections.Seq.FoldLeft((ids: seq<string>, row: SourceRow) => addSourceId(ids,row),base,rows)) <==> (id in base || exists row :: row in rows && row.id == id)
  decreases |rows|
{
  reveal Std.Collections.Seq.FoldLeft();
  var fn := (ids: seq<string>, row: SourceRow) => addSourceId(ids,row);
  var result := Std.Collections.Seq.FoldLeft(fn,base,rows);
  if |rows| == 0 { assert result == base; }
  else {
    var head := rows[0];
    var tail := rows[1..];
    var chosen := addSourceId(base,head);
    assert rows == [head] + tail;
    assert result == Std.Collections.Seq.FoldLeft(fn,chosen,tail);
    SweepIdMembership(tail,chosen);
    ProofLib.FilterMember((id: string) => !(id in base),[head.id],head.id);
    ProofLib.FilterSubset((id: string) => !(id in base),[head.id]);
    forall id ensures id in result <==> (id in base || exists row :: row in rows && row.id == id)
    {
      assert id in result <==> (id in chosen || exists row :: row in tail && row.id == id);
      assert id in chosen <==> (id in base || id == head.id);
    }
  }
}

lemma SweepMediaMembership(rows: seq<SourceRow>, base: seq<string>)
  ensures forall media :: (media in Std.Collections.Seq.FoldLeft((refs: seq<string>, row: SourceRow) => addSourceMedia(refs,row),base,rows)) <==> (media in base || exists row :: row in rows && row.mediaRef == media && media != "")
  decreases |rows|
{
  reveal Std.Collections.Seq.FoldLeft();
  var fn := (refs: seq<string>, row: SourceRow) => addSourceMedia(refs,row);
  var result := Std.Collections.Seq.FoldLeft(fn,base,rows);
  if |rows| == 0 { assert result == base; }
  else {
    var head := rows[0];
    var tail := rows[1..];
    var chosen := addSourceMedia(base,head);
    assert rows == [head] + tail;
    assert result == Std.Collections.Seq.FoldLeft(fn,chosen,tail);
    SweepMediaMembership(tail,chosen);
    if head.mediaRef != "" {
      ProofLib.FilterMember((id: string) => !(id in base),[head.mediaRef],head.mediaRef);
      ProofLib.FilterSubset((id: string) => !(id in base),[head.mediaRef]);
    }
    forall media ensures media in result <==> (media in base || exists row :: row in rows && row.mediaRef == media && media != "")
    {
      assert media in result <==> (media in chosen || exists row :: row in tail && row.mediaRef == media && media != "");
      assert media in chosen <==> (media in base || (head.mediaRef != "" && media == head.mediaRef));
    }
  }
}

lemma SweepAllRemoved(s: Sweep)
  requires inv(s) && canWipe(s)
  ensures inv(wipe(s))
{
  var t := wipe(s);
  forall id | id in t.retainedIds
    ensures false
  {
    ProofLib.FilterMember((id: string) => !(id in s.collectedIds),s.retainedIds,id);
    assert id in allInputIds(s) && id in s.collectedIds;
  }
  assert |t.retainedIds| == 0 by {
    if |t.retainedIds| > 0 { assert t.retainedIds[0] in t.retainedIds; }
  }
  assert alwaysRetainedRowsComeFromInput(t);
}

lemma collectSources_ensures(s: Sweep)
  ensures (inv(s) ==> canCollectSources(s) ==> alwaysSourcePhaseFollowsOrdinaryScan(collectSources(s)))
  ensures (inv(s) ==> canCollectSources(s) ==> alwaysSourceCollectionComplete(collectSources(s)))
  ensures (inv(s) ==> canCollectSources(s) ==> alwaysSourceMediaRetained(collectSources(s)))
  ensures (inv(s) ==> canCollectSources(s) ==> alwaysWipeRemovesEveryRow(collectSources(s)))
  ensures (inv(s) ==> canCollectSources(s) ==> alwaysRetainedRowsComeFromInput(collectSources(s)))
  ensures (inv(s) ==> canCollectSources(s) ==> alwaysClassifiedIdsCoverInput(collectSources(s)))
{
  if inv(s) && canCollectSources(s) {
    SweepIdMembership(s.sourceRows,s.ordinaryRows);
    SweepMediaMembership(s.sourceRows,[]);
    var t := collectSources(s);
    assert t.collectedIds == allInputIds(s) && t.sourceRows == s.sourceRows;
    assert t.collectedMedia == Std.Collections.Seq.FoldLeft((refs: seq<string>, row: SourceRow) => addSourceMedia(refs,row),[],s.sourceRows);
    forall row | row in t.sourceRows
      ensures row.id in t.collectedIds && (row.mediaRef == "" || row.mediaRef in t.collectedMedia)
    {
      assert row in s.sourceRows;
      var ids := Std.Collections.Seq.FoldLeft((ids: seq<string>, row: SourceRow) => addSourceId(ids,row),s.ordinaryRows,s.sourceRows);
      assert ids == t.collectedIds;
      assert (row.id in ids) <==> (row.id in s.ordinaryRows || (exists other :: other in s.sourceRows && other.id == row.id));
      assert row.id in ids;
      if row.mediaRef != "" {
        var empty: seq<string> := [];
        var media := Std.Collections.Seq.FoldLeft((refs: seq<string>, row: SourceRow) => addSourceMedia(refs,row),empty,s.sourceRows);
        assert media == t.collectedMedia;
        assert (row.mediaRef in media) <==> (row.mediaRef in empty || (exists other :: other in s.sourceRows && other.mediaRef == row.mediaRef && row.mediaRef != ""));
        assert row.mediaRef in media;
      }
    }
  }
}

lemma wipe_ensures(s: Sweep)
  ensures (inv(s) ==> canWipe(s) ==> alwaysSourcePhaseFollowsOrdinaryScan(wipe(s)))
  ensures (inv(s) ==> canWipe(s) ==> alwaysSourceCollectionComplete(wipe(s)))
  ensures (inv(s) ==> canWipe(s) ==> alwaysSourceMediaRetained(wipe(s)))
  ensures (inv(s) ==> canWipe(s) ==> alwaysWipeRemovesEveryRow(wipe(s)))
  ensures (inv(s) ==> canWipe(s) ==> alwaysRetainedRowsComeFromInput(wipe(s)))
  ensures (inv(s) ==> canWipe(s) ==> alwaysClassifiedIdsCoverInput(wipe(s)))
{
  if inv(s) && canWipe(s) { SweepAllRemoved(s); }
}
